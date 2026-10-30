// llmTranslate — settings page logic
//
// The page is also the place where the two common setup problems get fixed,
// so a failed connection renders an actionable help panel (steps + copyable
// command) and keeps re-checking in the background until the user has Ollama
// running with at least one model installed.

const DEFAULT_URL = 'http://localhost:11434';
const RECOMMENDED_MODEL = 'gemma4:e4b';
const CONNECT_TIMEOUT_MS = 6000;
const RECHECK_MS = 5000;
// Exact origin for OLLAMA_ORIGINS, so Ollama is not opened to every extension.
const ORIGIN = `chrome-extension://${chrome.runtime.id}`;

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
const connHelp = $('connHelp');
const modelSelect = $('model');
const modelStatus = $('modelStatus');
const langSelect = $('targetLang');
const keepAliveSelect = $('keepAlive');
const saveBtn = $('saveBtn');
const saveStatus = $('saveStatus');

let savedModel = '';
let recheckTimer = null;

init();

async function init() {
  $('originsHint').textContent =
    `Windows (then restart Ollama):
setx OLLAMA_ORIGINS "${ORIGIN}"

` +
    `macOS / Linux:
export OLLAMA_ORIGINS="${ORIGIN}"`;

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

  savedModel = saved.model || '';
  urlInput.value = saved.ollamaUrl || DEFAULT_URL;
  langSelect.value = LANGUAGES.includes(saved.targetLang) ? saved.targetLang : 'English';
  keepAliveSelect.value = KEEP_ALIVE_OPTIONS.some((o) => o.value === saved.keepAlive)
    ? saved.keepAlive
    : '5m';

  connectBtn.addEventListener('click', () => connect());
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  urlInput.addEventListener('input', stopRecheck);
  saveBtn.addEventListener('click', save);
  modelSelect.addEventListener('change', () => {
    setStatus(modelStatus, '', '');
    if (connHelp.dataset.kind === 'model') hideHelp();
    updateSaveState();
  });

  // Pause background re-checks while the tab is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRecheck();
  });

  // Auto-connect on open with the saved URL.
  connect();
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) u = DEFAULT_URL;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

// ------------------------------------------------------------- connecting

// Probes the server. `silent` is used by the background re-check so the UI
// does not flicker between "Connecting…" and the error on every poll.
async function connect({ silent = false } = {}) {
  const base = normalizeUrl(urlInput.value);
  urlInput.value = base;

  if (!silent) {
    setStatus(connStatus, 'Connecting…', 'pending');
    connectBtn.disabled = true;
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">— loading… —</option>';
    hideHelp();
    setStatus(modelStatus, '', '');
    updateSaveState();
  }

  const result = await probeOllama(base, CONNECT_TIMEOUT_MS);

  if (!result.ok) {
    showProbeError(result, base);
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">— connect to load models —</option>';
    connectBtn.disabled = false;
    updateSaveState();
    startRecheck();
    return;
  }

  const models = result.models;

  if (models.length === 0) {
    setStatus(connStatus, 'Connected ✓ — but no models are installed', 'warn');
    showHelp({
      title: 'Install a translation model',
      steps: [
        'Open a terminal (Windows: press Win, type "cmd", press Enter).',
        'Paste the command below and press Enter.',
        'A few GB are downloaded — wait for "success". This page picks the model up automatically.'
      ],
      command: `ollama pull ${RECOMMENDED_MODEL}`
    });
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">— no models installed —</option>';
    connectBtn.disabled = false;
    updateSaveState();
    startRecheck();
    return;
  }

  // Connected with models — stop polling and fill the dropdown.
  stopRecheck();
  hideHelp();

  modelSelect.innerHTML = '';
  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    modelSelect.appendChild(opt);
  }
  modelSelect.disabled = false;

  const match = findModel(models, savedModel);
  let autoSelected = false;

  if (match) {
    modelSelect.value = match;
    if (match !== savedModel) {
      // Stored "llama3" while "llama3:latest" is installed — normalise it.
      savedModel = match;
      await chrome.storage.sync.set({ model: match });
    }
    setStatus(modelStatus, '', '');
  } else if (savedModel) {
    // The previously selected model was removed from the server.
    modelSelect.value = models[0];
    setStatus(
      modelStatus,
      `The previously selected model "${savedModel}" is no longer installed. ` +
      `"${models[0]}" is preselected — press Save settings to confirm.`,
      'warn'
    );
    showHelp({
      kind: 'model',
      title: `Reinstall "${savedModel}"?`,
      steps: ['Run this in a terminal if you want that model back, then press Connect.'],
      command: `ollama pull ${savedModel}`
    });
  } else if (models.length === 1) {
    // Only one model available — select and persist it automatically.
    modelSelect.value = models[0];
    savedModel = models[0];
    autoSelected = true;
    await chrome.storage.sync.set({ model: models[0] });
  }

  const suffix = autoSelected
    ? ` — "${models[0]}" auto-selected (only model installed)`
    : ` — ${models.length} model${models.length === 1 ? '' : 's'} found`;
  setStatus(connStatus, `Connected ✓${suffix}`, 'ok');

  connectBtn.disabled = false;
  updateSaveState();
}

function showProbeError(result, base) {
  if (result.code === 'forbidden') {
    setStatus(connStatus, '403 Forbidden — Ollama is running but blocks browser extensions.', 'error');
    showHelp({
      title: 'Allow extensions to call Ollama',
      steps: [
        'Windows: run the command below in cmd, then quit Ollama from the tray and start it again.',
        `macOS / Linux: export OLLAMA_ORIGINS="${ORIGIN}" before running "ollama serve".`,
        'Then press Connect again.'
      ],
      command: `setx OLLAMA_ORIGINS "${ORIGIN}"`
    });
    return;
  }

  if (result.code === 'not-ollama' || result.code === 'http-error') {
    setStatus(
      connStatus,
      `${base} answered${result.status ? ` with HTTP ${result.status}` : ''}, but it is not an Ollama API.`,
      'error'
    );
    showHelp({
      title: 'Check the URL',
      steps: [
        `Ollama listens on ${DEFAULT_URL} by default.`,
        'If you changed OLLAMA_HOST, enter that address here instead.'
      ]
    });
    return;
  }

  if (result.code === 'timeout') {
    setStatus(connStatus, `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s. Is Ollama busy or stuck?`, 'error');
    showHelp({
      title: 'Ollama is not answering',
      steps: [
        'The server accepted the connection but did not reply — it may be loading a large model.',
        'Wait a moment, or restart Ollama, then press Connect.'
      ]
    });
    return;
  }

  // offline
  setStatus(connStatus, `Cannot reach Ollama at ${base}. It does not look like it is running.`, 'error');
  showHelp({
    title: 'Start Ollama',
    steps: isLocalUrl(base)
      ? [
          'Not installed yet? Download it from ollama.com/download and run the installer.',
          'Already installed? Launch the Ollama app, or run "ollama serve" in a terminal.',
          `Check it works: open ${base} in a new tab — it should say "Ollama is running".`,
          'This page keeps checking and connects by itself once Ollama is up.'
        ]
      : [
          `Make sure the server at ${base} is running and reachable from this machine.`,
          `Remote servers also need OLLAMA_ORIGINS to allow "${ORIGIN}".`
        ],
    link: isLocalUrl(base) ? 'https://ollama.com/download' : null
  });
}

// ------------------------------------------------------------ help panel

function showHelp({ title, steps = [], command, link, kind = 'connection' }) {
  connHelp.innerHTML = '';
  connHelp.dataset.kind = kind;

  if (title) {
    const h = document.createElement('strong');
    h.textContent = title;
    connHelp.appendChild(h);
  }

  if (steps.length) {
    const ol = document.createElement('ol');
    for (const step of steps) {
      const li = document.createElement('li');
      li.textContent = step;
      ol.appendChild(li);
    }
    connHelp.appendChild(ol);
  }

  if (command) {
    const row = document.createElement('div');
    row.className = 'cmd-row';

    const code = document.createElement('code');
    code.textContent = command;
    row.appendChild(code);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        btn.textContent = 'Copied ✓';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      } catch {
        btn.textContent = 'Copy failed';
      }
    });
    row.appendChild(btn);

    connHelp.appendChild(row);
  }

  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.replace(/^https?:\/\//, '');
    connHelp.appendChild(a);
  }

  connHelp.hidden = false;
}

function hideHelp() {
  connHelp.hidden = true;
  connHelp.innerHTML = '';
  delete connHelp.dataset.kind;
}

// ------------------------------------------------------- background retry

// While the connection is broken, keep probing so the page recovers on its
// own as soon as the user starts Ollama or finishes "ollama pull".
function startRecheck() {
  stopRecheck();
  recheckTimer = setInterval(() => {
    if (document.hidden) return;
    connect({ silent: true });
  }, RECHECK_MS);
}

function stopRecheck() {
  if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
}

// --------------------------------------------------------------- helpers

function updateSaveState() {
  saveBtn.disabled = !modelSelect.value || modelSelect.disabled;
}

async function save() {
  savedModel = modelSelect.value;
  await chrome.storage.sync.set({
    ollamaUrl: normalizeUrl(urlInput.value),
    model: savedModel,
    targetLang: langSelect.value,
    keepAlive: keepAliveSelect.value
  });
  setStatus(modelStatus, '', '');
  if (connHelp.dataset.kind === 'model') hideHelp();
  setStatus(saveStatus, 'Saved ✓', 'ok');
  setTimeout(() => setStatus(saveStatus, '', ''), 2000);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
