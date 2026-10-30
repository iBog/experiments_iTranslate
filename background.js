// llmTranslate — background service worker
// Creates the context menu, calls the local Ollama server, and sends the
// result to the content script for display at the cursor position.
//
// Before every translation a preflight probe runs against /api/tags so the
// two common setup failures get an actionable popup instead of a raw error:
//   1. Ollama is not running (or the URL is wrong / blocked by CORS)
//   2. The configured model is not installed on the server
//
// Progress tracking:
//  - GET /api/ps tells us whether the model is already loaded in memory
//    (Ollama exposes no load percentage, only loaded / not loaded).
//  - The translation itself uses stream:true, so tokens are forwarded to
//    the popup live as they are generated.

importScripts('ollama.js');

const MENU_ID = 'llmtranslate-selection';
const RECOMMENDED_MODEL = 'gemma4:e4b';
const PROBE_TIMEOUT_MS = 5000;
// No chunk for this long = Ollama is stuck. Generous: a cold load of a big
// model sends nothing until it is in memory.
const STREAM_IDLE_MS = 180000;
// Exact origin for OLLAMA_ORIGINS, so Ollama is not opened to every extension.
const ORIGIN = `chrome-extension://${chrome.runtime.id}`;

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  model: '',
  targetLang: 'English',
  keepAlive: '5m' // how long Ollama keeps the model in memory ("-1" = forever)
};

// Running translation per tab, aborted when the popup is closed or replaced.
const active = new Map();

// Last selected text per tab, so the error popup can offer a Retry button.
// Kept in storage.session: the service worker is killed after ~30s idle.
const reqKey = (tabId) => `req:${tabId}`;

async function lastText(tabId) {
  if (tabId == null) return null;
  const key = reqKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'llmTranslate "%s"',
    contexts: ['selection']
  });
});

// Clicking the toolbar icon opens the settings page.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  active.get(tabId)?.abort();
  active.delete(tabId);
  chrome.storage.session.remove(reqKey(tabId));
});

// Actions triggered from the error popup in the content script.
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;

  if (msg?.type === 'llmtranslate-cancel') {
    if (tabId != null) active.get(tabId)?.abort();
    return;
  }

  if (msg?.type === 'llmtranslate-open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg?.type === 'llmtranslate-retry') {
    lastText(tabId).then((text) => { if (text) translate(tabId, frameId, text); });
    return;
  }

  if (msg?.type === 'llmtranslate-use-model' && msg.model) {
    chrome.storage.sync.set({ model: msg.model })
      .then(() => lastText(tabId))
      .then((text) => { if (text) translate(tabId, frameId, text); });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  await chrome.storage.session.set({ [reqKey(tab.id)]: text });
  translate(tab.id, info.frameId ?? 0, text);
});

// ---------------------------------------------------------------- pipeline

// frameId: the frame where the text was selected (0 = top), so the popup
// opens inside that iframe at the cursor.
async function translate(tabId, frameId, text) {
  active.get(tabId)?.abort();
  const ctrl = new AbortController();
  active.set(tabId, ctrl);
  // Once cancelled, nothing more is pushed to the page.
  const send = (message) => (ctrl.signal.aborted ? false : sendToTab(tabId, frameId, message));

  const settings = await getSettings();
  const base = settings.ollamaUrl.replace(/\/+$/, '');

  // Show the popup immediately so the user sees something during the probe.
  const delivered = await deliver(tabId, frameId, {
    type: 'llmtranslate-loading',
    targetLang: settings.targetLang,
    model: settings.model
  });
  if (!delivered) {
    // chrome://, Web Store, PDF viewer… — scripts are not allowed there.
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setTitle({ tabId, title: 'llmTranslate cannot show translations on this page' });
    return;
  }

  await send({
    type: 'llmtranslate-status',
    phase: 'connecting',
    model: settings.model,
    targetLang: settings.targetLang
  });

  // --- Preflight: is the server up, and is the model installed? ----------
  const probe = await probeOllama(base, PROBE_TIMEOUT_MS);
  if (!probe.ok) {
    await send(serverErrorPayload(probe, base));
    return;
  }

  if (probe.models.length === 0) {
    await send({
      type: 'llmtranslate-error',
      code: 'no-models',
      title: 'No models installed',
      message: `Ollama is running at ${base}, but no model is installed yet. Install the recommended translation model:`,
      command: `ollama pull ${RECOMMENDED_MODEL}`,
      steps: [
        'Open a terminal (Windows: press Win, type "cmd", press Enter).',
        'Paste the command below and press Enter.',
        'Wait until the download finishes, then press Retry.'
      ],
      canRetry: true
    });
    return;
  }

  // Resolve the configured model against what is actually installed.
  let model = findModel(probe.models, settings.model);

  if (!model && !settings.model && probe.models.length === 1) {
    // Nothing configured yet, but there is exactly one model — use it.
    model = probe.models[0];
    chrome.storage.sync.set({ model });
  }

  if (!model && !settings.model) {
    await send({
      type: 'llmtranslate-error',
      code: 'no-model-selected',
      title: 'No model selected',
      message: `Ollama is running and has ${probe.models.length} models installed. Pick the one llmTranslate should use.`,
      models: probe.models,
      canRetry: false
    });
    return;
  }

  if (!model) {
    await send({
      type: 'llmtranslate-error',
      code: 'model-missing',
      title: 'Model not installed',
      message: `The selected model "${settings.model}" is not installed on ${base}. Install it, or switch to a model you already have.`,
      command: `ollama pull ${settings.model}`,
      models: probe.models,
      canRetry: true
    });
    return;
  }

  if (model !== settings.model) {
    // e.g. stored "llama3", installed "llama3:latest" — remember the exact name.
    settings.model = model;
    chrome.storage.sync.set({ model });
  }

  // --- Translate ---------------------------------------------------------
  let firstChunkSeen = false;
  let pollTimer = null;

  try {
    // Phase detection: is the model already resident in memory?
    const loaded = await isModelLoaded(base, settings.model);
    await send({
      type: 'llmtranslate-status',
      phase: loaded ? 'translating' : 'loading-model',
      model: settings.model,
      targetLang: settings.targetLang
    });

    // While the model is cold-loading, poll /api/ps so the popup can flip
    // from "loading model" to "processing prompt" the moment it's resident.
    if (!loaded) {
      pollTimer = setInterval(async () => {
        if (firstChunkSeen) { clearInterval(pollTimer); return; }
        if (await isModelLoaded(base, settings.model)) {
          clearInterval(pollTimer);
          if (!firstChunkSeen) {
            send({
              type: 'llmtranslate-status',
              phase: 'starting',
              model: settings.model,
              targetLang: settings.targetLang
            });
          }
        }
      }, 2000);
    }

    let lastSent = 0;
    let thinkingShown = false;
    const translated = await streamChat(base, settings, text, ctrl.signal, (fullText) => {
      firstChunkSeen = true;
      const visible = stripThinking(fullText);
      const now = Date.now();
      if (!visible) {
        // Model is inside a <think> block — nothing displayable yet.
        if (thinkingShown) return;
        thinkingShown = true;
        send({
          type: 'llmtranslate-status',
          phase: 'thinking',
          model: settings.model,
          targetLang: settings.targetLang
        });
        return;
      }
      if (now - lastSent < 80) return; // throttle UI updates
      lastSent = now;
      send({
        type: 'llmtranslate-progress',
        text: visible,
        targetLang: settings.targetLang,
        model: settings.model
      });
    });

    const finalText = stripThinking(translated);
    if (!finalText) throw new Error('Ollama returned an empty response.');
    await send({
      type: 'llmtranslate-result',
      original: text,
      translated: finalText,
      targetLang: settings.targetLang,
      model: settings.model
    });
  } catch (err) {
    await send(translationErrorPayload(err, base, settings, probe.models));
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

// ----------------------------------------------------------------- probing

// True if the model is currently loaded in memory (GET /api/ps).
async function isModelLoaded(base, model) {
  try {
    const resp = await fetchWithTimeout(`${base}/api/ps`, {}, PROBE_TIMEOUT_MS);
    if (!resp.ok) return false;
    const data = await resp.json();
    return (data.models || []).some((m) => m.name === model || m.model === model);
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- error text

function serverErrorPayload(probe, base) {
  const isLocal = isLocalUrl(base);

  if (probe.code === 'forbidden') {
    return {
      type: 'llmtranslate-error',
      code: 'forbidden',
      title: 'Ollama blocked the request (403)',
      message:
        'Ollama refuses requests from browser extensions until their origin is allowed. ' +
        'Run the command below, then restart Ollama.',
      command: `setx OLLAMA_ORIGINS "${ORIGIN}"`,
      steps: [
        'Windows: open cmd, run the command below, then quit Ollama from the tray and start it again.',
        `macOS / Linux: export OLLAMA_ORIGINS="${ORIGIN}" before running "ollama serve".`
      ],
      canRetry: true
    };
  }

  if (probe.code === 'not-ollama' || probe.code === 'http-error') {
    return {
      type: 'llmtranslate-error',
      code: probe.code,
      title: 'Not an Ollama server',
      message:
        `${base} answered${probe.status ? ` with HTTP ${probe.status}` : ''}, but it does not look like an Ollama API. ` +
        'Check the URL in the llmTranslate settings (default: http://localhost:11434).',
      canRetry: true
    };
  }

  // offline / timeout
  return {
    type: 'llmtranslate-error',
    code: probe.code === 'timeout' ? 'timeout' : 'offline',
    title: probe.code === 'timeout' ? 'Ollama is not responding' : 'Ollama is not running',
    message:
      probe.code === 'timeout'
        ? `${base} accepted the connection but did not answer within ${PROBE_TIMEOUT_MS / 1000}s. The server may be busy or stuck.`
        : `Cannot reach Ollama at ${base}. Start Ollama and try again${isLocal ? '' : ', or check the URL in the settings'}.`,
    steps: isLocal
      ? [
          'Install Ollama from ollama.com/download if you have not yet.',
          'Start it: launch the Ollama app, or run "ollama serve" in a terminal.',
          `Verify it works: open ${base} in a tab — it should say "Ollama is running".`,
          'Then press Retry below.'
        ]
      : [
          `Make sure the server at ${base} is up and reachable from this machine.`,
          'Check the URL in the llmTranslate settings.'
        ],
    link: isLocal ? 'https://ollama.com/download' : null,
    canRetry: true
  };
}

function translationErrorPayload(err, base, settings, models) {
  if (err?.code === 'stalled') {
    return {
      type: 'llmtranslate-error',
      code: 'stalled',
      title: 'Ollama stopped responding',
      message: `No output from "${settings.model}" for ${STREAM_IDLE_MS / 60000} minutes, so the translation was stopped. Ollama may be stuck — restart it and try again.`,
      canRetry: true
    };
  }

  // Model removed mid-flight, or /api/chat disagrees with /api/tags.
  if (err?.status === 404 || /model .*not found|try pulling/i.test(err?.message || '')) {
    return {
      type: 'llmtranslate-error',
      code: 'model-missing',
      title: 'Model not installed',
      message: `Ollama does not have "${settings.model}". Install it, or switch to a model you already have.`,
      command: `ollama pull ${settings.model}`,
      models: (models || []).filter((m) => m !== settings.model),
      canRetry: true
    };
  }

  if (err?.status === 403) {
    return serverErrorPayload({ code: 'forbidden' }, base);
  }

  // Out of memory is the other frequent local-LLM failure.
  if (/memory|out of vram|cuda|allocat/i.test(err?.message || '')) {
    return {
      type: 'llmtranslate-error',
      code: 'out-of-memory',
      title: 'Not enough memory for this model',
      message:
        `Ollama could not load "${settings.model}": ${err.message} ` +
        'Close other applications, or switch to a smaller model.',
      models: (models || []).filter((m) => m !== settings.model),
      canRetry: true
    };
  }

  if (err instanceof TypeError) {
    // Connection dropped while streaming — Ollama died or was restarted.
    return serverErrorPayload({ code: 'offline' }, base);
  }

  return {
    type: 'llmtranslate-error',
    code: 'unknown',
    title: 'Translation failed',
    message: err?.message || 'Unknown error while translating.',
    canRetry: true
  };
}

// -------------------------------------------------------------------- misc

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// Tabs opened before install/update have no live content script — inject it.
// A freshly injected script has not seen the right-click, so the popup
// opens at the viewport centre this one time.
async function deliver(tabId, frameId, message) {
  if (await sendToTab(tabId, frameId, message)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
  } catch {
    return false;
  }
  return sendToTab(tabId, frameId, message);
}

async function sendToTab(tabId, frameId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId });
    return true;
  } catch (e) {
    // Content script not present on this page.
    return false;
  }
}

// Streaming chat call. Invokes onUpdate(accumulatedText) per chunk,
// resolves with the full text when done.
async function streamChat(base, settings, text, signal, onUpdate) {
  // Restarted on every chunk; fires only when the stream goes silent.
  const idle = new AbortController();
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS);
  };
  touch();
  try {
    return await readChat(base, settings, text, AbortSignal.any([signal, idle.signal]), touch, onUpdate);
  } catch (err) {
    if (idle.signal.aborted && !signal.aborted) {
      const e = new Error('Ollama stopped responding.');
      e.code = 'stalled';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

async function readChat(base, settings, text, signal, touch, onUpdate) {
  const resp = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      keep_alive: settings.keepAlive === '-1' ? -1 : settings.keepAlive,
      options: { temperature: 0.2 },
      messages: [
        {
          role: 'system',
          content:
            `You are a professional translator. Translate the user's text into ${settings.targetLang}. ` +
            `Preserve meaning, tone and formatting. ` +
            `Respond with ONLY the translated text — no explanations, no quotes, no preamble.`
        },
        { role: 'user', content: text }
      ]
    })
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body).error || detail; } catch { /* plain-text body */ }
    const err = new Error(detail || `Ollama responded with HTTP ${resp.status}.`);
    err.status = resp.status;
    throw err;
  }

  // Ollama streams NDJSON: one JSON object per line.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) {
        const e = new Error(obj.error);
        if (/not found|try pulling/i.test(obj.error)) e.status = 404;
        throw e;
      }
      if (obj.message?.content) {
        full += obj.message.content;
        onUpdate(full);
      }
      if (obj.done) return full;
    }
  }
  return full;
}

