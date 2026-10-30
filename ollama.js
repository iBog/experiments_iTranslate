// llmTranslate — helpers shared by the service worker (importScripts), the
// settings page (<script>) and the Node tests (tests/ollama.test.js).

async function fetchWithTimeout(url, options = {}, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Checks that the server answers and returns the installed model list.
// Never throws — resolves to {ok:true, models} or {ok:false, code, …}.
async function probeOllama(base, timeoutMs) {
  let resp;
  try {
    resp = await fetchWithTimeout(`${base}/api/tags`, {}, timeoutMs);
  } catch (err) {
    return { ok: false, code: err?.name === 'AbortError' ? 'timeout' : 'offline' };
  }

  if (resp.status === 403) return { ok: false, code: 'forbidden' };
  if (!resp.ok) return { ok: false, code: 'http-error', status: resp.status };

  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, code: 'not-ollama' };
  }
  if (!data || !Array.isArray(data.models)) return { ok: false, code: 'not-ollama' };

  return { ok: true, models: data.models.map((m) => m.name).filter(Boolean).sort() };
}

// Matches a configured model name against the installed ones, tolerating a
// missing/extra ":latest" tag and case differences.
function findModel(models, wanted) {
  if (!wanted) return null;
  const strip = (s) => s.toLowerCase().replace(/:latest$/, '');
  const w = strip(wanted);
  return models.find((m) => m.toLowerCase() === wanted.toLowerCase())
    || models.find((m) => strip(m) === w)
    || null;
}

function isLocalUrl(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
}

// Some models (deepseek-r1, qwen3…) emit <think>…</think> blocks — remove
// them, including a still-open block during streaming.
function stripThinking(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}
