// iTranslate — background service worker
// Creates the context menu, calls the local Ollama server, and sends the
// result to the content script for display at the cursor position.
//
// Progress tracking:
//  - GET /api/ps tells us whether the model is already loaded in memory
//    (Ollama exposes no load percentage, only loaded / not loaded).
//  - The translation itself uses stream:true, so tokens are forwarded to
//    the popup live as they are generated.

const MENU_ID = 'itranslate-selection';

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  model: '',
  targetLang: 'English',
  keepAlive: '5m' // how long Ollama keeps the model in memory ("-1" = forever)
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'iTranslate "%s"',
    contexts: ['selection']
  });
});

// Clicking the toolbar icon opens the settings page.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;

  const text = (info.selectionText || '').trim();
  if (!text) return;

  const settings = await getSettings();

  if (!settings.model) {
    // No model configured yet — if the server has exactly one model
    // installed, use it automatically.
    const only = await getSingleAvailableModel(settings.ollamaUrl);
    if (only) {
      settings.model = only;
      chrome.storage.sync.set({ model: only });
    } else {
      await sendToTab(tab.id, {
        type: 'itranslate-error',
        error: 'No model selected. Open the iTranslate settings page (extension icon) and choose a model.'
      });
      return;
    }
  }

  // Show loading popup immediately at the cursor position.
  const delivered = await sendToTab(tab.id, {
    type: 'itranslate-loading',
    targetLang: settings.targetLang,
    model: settings.model
  });
  if (!delivered) return; // Page where content scripts cannot run (chrome://, Web Store, PDF viewer…)

  const base = settings.ollamaUrl.replace(/\/+$/, '');
  let firstChunkSeen = false;
  let pollTimer = null;

  try {
    // Phase detection: is the model already resident in memory?
    const loaded = await isModelLoaded(base, settings.model);
    await sendToTab(tab.id, {
      type: 'itranslate-status',
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
            sendToTab(tab.id, {
              type: 'itranslate-status',
              phase: 'starting',
              model: settings.model,
              targetLang: settings.targetLang
            });
          }
        }
      }, 2000);
    }

    let lastSent = 0;
    const translated = await streamChat(base, settings, text, (fullText) => {
      firstChunkSeen = true;
      const visible = stripThinking(fullText);
      const now = Date.now();
      if (!visible) {
        // Model is inside a <think> block — nothing displayable yet.
        sendToTab(tab.id, {
          type: 'itranslate-status',
          phase: 'thinking',
          model: settings.model,
          targetLang: settings.targetLang
        });
        return;
      }
      if (now - lastSent < 80) return; // throttle UI updates
      lastSent = now;
      sendToTab(tab.id, {
        type: 'itranslate-progress',
        text: visible,
        targetLang: settings.targetLang,
        model: settings.model
      });
    });

    const finalText = stripThinking(translated);
    if (!finalText) throw new Error('Ollama returned an empty response.');
    await sendToTab(tab.id, {
      type: 'itranslate-result',
      original: text,
      translated: finalText,
      targetLang: settings.targetLang,
      model: settings.model
    });
  } catch (err) {
    await sendToTab(tab.id, {
      type: 'itranslate-error',
      error: describeError(err, settings.ollamaUrl)
    });
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
});

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (e) {
    // Content script not present on this page.
    return false;
  }
}

// Returns the model name if the server has exactly one installed, else null.
async function getSingleAvailableModel(url) {
  try {
    const base = url.replace(/\/+$/, '');
    const resp = await fetch(`${base}/api/tags`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name);
    return models.length === 1 ? models[0] : null;
  } catch {
    return null;
  }
}

// True if the model is currently loaded in memory (GET /api/ps).
async function isModelLoaded(base, model) {
  try {
    const resp = await fetch(`${base}/api/ps`);
    if (!resp.ok) return false;
    const data = await resp.json();
    return (data.models || []).some((m) => m.name === model || m.model === model);
  } catch {
    return false;
  }
}

// Streaming chat call. Invokes onUpdate(accumulatedText) per chunk,
// resolves with the full text when done.
async function streamChat(base, settings, text, onUpdate) {
  const resp = await fetch(`${base}/api/chat`, {
    method: 'POST',
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
    const err = new Error(`Ollama responded with HTTP ${resp.status}. ${body.slice(0, 200)}`);
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
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(obj.error);
      if (obj.message?.content) {
        full += obj.message.content;
        onUpdate(full);
      }
      if (obj.done) return full;
    }
  }
  return full;
}

// Some models (deepseek-r1, qwen3…) emit <think>…</think> blocks — remove
// them, including a still-open block during streaming.
function stripThinking(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function describeError(err, url) {
  if (err && err.status === 403) {
    return (
      `Ollama rejected the request (403 Forbidden). Allow Chrome extensions to call Ollama by setting the ` +
      `environment variable OLLAMA_ORIGINS to "chrome-extension://*" and restarting Ollama. ` +
      `On Windows: setx OLLAMA_ORIGINS "chrome-extension://*"`
    );
  }
  if (err instanceof TypeError) {
    return `Cannot reach Ollama at ${url}. Is Ollama running? Check the URL in the iTranslate settings.`;
  }
  return err?.message || 'Unknown error while translating.';
}
