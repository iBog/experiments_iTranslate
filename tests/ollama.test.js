// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ollama.js is a classic browser script: load it into a sandbox with a fake fetch.
function load(fetch) {
  const ctx = { fetch, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ollama.js'), 'utf8'), ctx);
  return ctx;
}

const json = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
});

test('findModel: exact, :latest and case tolerant', () => {
  const { findModel } = load();
  const models = ['gemma4:e4b', 'llama3.2:latest', 'Qwen3:8b'];
  assert.equal(findModel(models, 'gemma4:e4b'), 'gemma4:e4b');
  assert.equal(findModel(models, 'llama3.2'), 'llama3.2:latest');
  assert.equal(findModel(models, 'qwen3:8B'), 'Qwen3:8b');
  assert.equal(findModel(models, 'mistral'), null);
  assert.equal(findModel(models, ''), null);
});

test('stripThinking: closed and still-open think blocks', () => {
  const { stripThinking } = load();
  assert.equal(stripThinking('<think>hmm</think> Hallo'), 'Hallo');
  assert.equal(stripThinking('<think>still going'), '');
  assert.equal(stripThinking('a<THINK>x</THINK>b'), 'ab');
});

test('isLocalUrl', () => {
  const { isLocalUrl } = load();
  assert.ok(isLocalUrl('http://localhost:11434'));
  assert.ok(isLocalUrl('http://127.0.0.1'));
  assert.ok(isLocalUrl('http://[::1]:11434'));
  assert.ok(!isLocalUrl('http://localhost.evil.com'));
  assert.ok(!isLocalUrl('http://192.168.1.5:11434'));
});

test('probeOllama: maps server answers to codes', async () => {
  const base = 'http://x';
  let r = await load(json(200, { models: [{ name: 'b' }, { name: 'a' }, {}] })).probeOllama(base, 1000);
  assert.deepEqual({ ...r, models: [...r.models] }, { ok: true, models: ['a', 'b'] });

  r = await load(json(403, {})).probeOllama(base, 1000);
  assert.equal(r.code, 'forbidden');

  r = await load(json(500, {})).probeOllama(base, 1000);
  assert.equal(r.code, 'http-error');
  assert.equal(r.status, 500);

  r = await load(json(200, 'not json')).probeOllama(base, 1000);
  assert.equal(r.code, 'not-ollama');

  r = await load(json(200, { hello: 1 })).probeOllama(base, 1000);
  assert.equal(r.code, 'not-ollama');

  r = await load(async () => { throw new TypeError('Failed to fetch'); }).probeOllama(base, 1000);
  assert.equal(r.code, 'offline');

  const hang = (url, { signal }) => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  r = await load(hang).probeOllama(base, 20);
  assert.equal(r.code, 'timeout');
});
