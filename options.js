// iTranslate — settings page logic

const DEFAULT_URL = 'http://localhost:11434';

// Top 41 languages by global usage.
const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Russian', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese',
  'Korean', 'Arabic', 'Hindi', 'Bengali', 'Turkish', 'Dutch', 'Polish',
  'Ukrainian', 'Czech', 'Swedish', 'Norwegian', 'Danish', 'Finnish',
  'Greek', 'Hebrew', 'Hungarian', 'Romanian', 'Bulgarian', 'Serbian',
  'Croatian', 'Slovak', 'Macedonian', 'Vietnamese', 'Thai', 'Indonesian',
  'Malay', 'Filipino', 'Persian', 'Urdu', 'Tamil', 'Telugu'
];

// keep_alive values accepted by the Ollama API ("-1" = never unload).
const KEEP_ALIVE_OPTIONS = [
  { value: '5m', label: '5 minutes (Ollama default)' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '3h', label: '3 hours' },
  { value: '6h', label: '6 hours' },
  { value: '-1', label: 'Forever (until Ollama restarts)' }
];

const $ = (id) => document.getElementById(id);
const urlInput = $('ollamaUrl');
const connectBtn = $('connectBtn');
const connStatus = $('connStatus');
const modelSelect = $('model');
const langSelect = $('targetLang');
const keepAliveSelect = $('keepAlive');
const saveBtn = $('saveBtn');
const saveStatus = $('saveStatus');

init();

async function init() {
  // Fill language dropdown.
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    langSelect.appendChild(opt);
  }

  // Fill keep-alive dropdown.
  for (const { value, label } of KEEP_ALIVE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    keepAliveSelect.appendChild(opt);
  }

  const saved = await chrome.storage.sync.get({
    ollamaUrl: DEFAULT_URL,
    model: '',
    targetLang: 'English',
    keepAlive: '5m'
  });

  urlInput.value = saved.ollamaUrl || DEFAULT_URL;
  langSelect.value = LANGUAGES.includes(saved.targetLang) ? saved.targetLang : 'English';
  keepAliveSelect.value = KEEP_ALIVE_OPTIONS.some((o) => o.value === saved.keepAlive)
    ? saved.keepAlive
    : '5m';

  connectBtn.addEventListener('click', () => connect(saved.model));
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(saved.model); });
  saveBtn.addEventListener('click', save);
  modelSelect.addEventListener('change', updateSaveState);

  // Auto-connect on open with the saved URL.
  connect(saved.model);
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) u = DEFAULT_URL;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

async function connect(preferredModel) {
  const base = normalizeUrl(urlInput.value);
  urlInput.value = base;

  setStatus(connStatus, 'Connecting…', 'pending');
  connectBtn.disabled = true;
  modelSelect.disabled = true;
  modelSelect.innerHTML = '<option value="">— loading… —</option>';
  updateSaveState();

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 403) {
        throw new Error('403 Forbidden — set OLLAMA_ORIGINS="chrome-extension://*" and restart Ollama (see hint below).');
      }
      throw new Error(`Server responded with HTTP ${resp.status}.`);
    }

    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name).sort();

    if (models.length === 0) {
      setStatus(connStatus, 'Connected, but no models installed. Run: ollama pull gemma4:e4b', 'warn');
      modelSelect.innerHTML = '<option value="">— no models found —</option>';
      return;
    }

    modelSelect.innerHTML = '';
    for (const name of models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    }
    if (preferredModel && models.includes(preferredModel)) {
      modelSelect.value = preferredModel;
    }
    modelSelect.disabled = false;

    if (models.length === 1) {
      // Only one model available — select and persist it automatically.
      modelSelect.value = models[0];
      await chrome.storage.sync.set({ model: models[0] });
      setStatus(connStatus, `Connected ✓ — "${models[0]}" auto-selected (only model installed)`, 'ok');
    } else {
      setStatus(connStatus, `Connected ✓ — ${models.length} models found`, 'ok');
    }
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? `Connection timed out. Is Ollama running at ${base}?`
      : (err instanceof TypeError
        ? `Cannot reach ${base}. Is Ollama running?`
        : err.message);
    setStatus(connStatus, msg, 'error');
    modelSelect.innerHTML = '<option value="">— connect to load models —</option>';
  } finally {
    connectBtn.disabled = false;
    updateSaveState();
  }
}

function updateSaveState() {
  saveBtn.disabled = !modelSelect.value;
}

async function save() {
  await chrome.storage.sync.set({
    ollamaUrl: normalizeUrl(urlInput.value),
    model: modelSelect.value,
    targetLang: langSelect.value,
    keepAlive: keepAliveSelect.value
  });
  setStatus(saveStatus, 'Saved ✓', 'ok');
  setTimeout(() => setStatus(saveStatus, '', ''), 2000);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
