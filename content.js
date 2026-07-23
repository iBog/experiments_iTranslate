// llmTranslate — content script
// Tracks the cursor position of the last right-click and shows the
// translation popup at that position, isolated inside a Shadow DOM.
//
// Message flow from background:
//   llmtranslate-loading  → popup with spinner + elapsed timer
//   llmtranslate-status   → phase label updates (loading model / processing / thinking)
//   llmtranslate-progress → live streaming translation text
//   llmtranslate-result   → final text (stops timer, enables Copy)
//   llmtranslate-error    → error box

(() => {
  'use strict';

  let lastPos = { x: innerWidth / 2, y: innerHeight / 2 };
  let host = null; // popup host element
  let shadow = null;

  // Streaming / progress state
  let statusLabelEl = null;
  let elapsedEl = null;
  let streamTextEl = null;
  let streamCopyBtn = null;
  let streamStateEl = null;
  let currentText = '';
  let timerId = null;
  let startedAt = 0;

  // Remember where the context menu was opened.
  document.addEventListener(
    'contextmenu',
    (e) => { lastPos = { x: e.clientX, y: e.clientY }; },
    true
  );

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'llmtranslate-loading':
        startedAt = Date.now();
        showPopup(() => renderLoading(msg));
        startTimer();
        break;
      case 'llmtranslate-status':
        updateStatus(msg);
        break;
      case 'llmtranslate-progress':
        ensureStreamView(msg);
        currentText = msg.text;
        if (streamTextEl) {
          streamTextEl.textContent = msg.text;
          streamTextEl.scrollTop = streamTextEl.scrollHeight;
        }
        break;
      case 'llmtranslate-result':
        ensureStreamView(msg);
        currentText = msg.translated;
        if (streamTextEl) streamTextEl.textContent = msg.translated;
        finalize(msg);
        break;
      case 'llmtranslate-error':
        stopTimer();
        showPopup(() => renderError(msg.error));
        break;
    }
  });

  // ---------------------------------------------------------------- popup

  // Takes a builder function so content is created AFTER removePopup()
  // has cleared the previous popup's element references — building the
  // content first would let removePopup() null the fresh refs.
  function showPopup(build) {
    removePopup();

    host = document.createElement('div');
    host.setAttribute('data-llmtranslate-popup', '');
    // Keep the host inert relative to page styles.
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.left = '0';
    host.style.top = '0';

    const contentEl = build();
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(styleEl());
    shadow.appendChild(contentEl);
    (document.body || document.documentElement).appendChild(host);

    positionPopup(contentEl);

    // Dismiss on outside click or Escape.
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function positionPopup(box) {
    const margin = 12;
    const rect = box.getBoundingClientRect();
    let x = lastPos.x + margin;
    let y = lastPos.y + margin;
    if (x + rect.width + margin > innerWidth) x = Math.max(margin, innerWidth - rect.width - margin);
    if (y + rect.height + margin > innerHeight) y = Math.max(margin, lastPos.y - rect.height - margin);
    host.style.left = `${Math.round(x)}px`;
    host.style.top = `${Math.round(y)}px`;
  }

  function removePopup() {
    stopTimer();
    statusLabelEl = elapsedEl = streamTextEl = streamCopyBtn = streamStateEl = null;
    currentText = '';
    if (host) {
      host.remove();
      host = null;
      shadow = null;
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
  }

  function onOutside(e) {
    if (host && !e.composedPath().includes(host)) removePopup();
  }

  function onKey(e) {
    if (e.key === 'Escape') removePopup();
  }

  // ---------------------------------------------------------------- timer

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      if (elapsedEl) {
        elapsedEl.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  // ------------------------------------------------------- phase handling

  const PHASE_LABELS = {
    'loading-model': (m) => `Loading ${m.model} into memory… (first run can take a while)`,
    'starting': (m) => `Model loaded — processing prompt…`,
    'thinking': (m) => `Model is thinking…`,
    'translating': (m) => `Translating to ${m.targetLang}…`
  };

  function updateStatus(msg) {
    const label = (PHASE_LABELS[msg.phase] || PHASE_LABELS.translating)(msg);
    if (statusLabelEl) statusLabelEl.textContent = label;
    if (streamStateEl) streamStateEl.textContent = label;
  }

  // Switch the loading popup into the streaming-result view (once).
  function ensureStreamView(msg) {
    if (streamTextEl) return;
    showPopup(() => renderStream(msg));
    startTimer();
  }

  function finalize(msg) {
    stopTimer();
    if (streamStateEl) {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      streamStateEl.textContent = `${msg.model || ''}${secs ? ` · ${secs}s` : ''}`;
      streamStateEl.classList.remove('itr-live');
    }
    if (streamCopyBtn) streamCopyBtn.disabled = false;
  }

  // ------------------------------------------------------------- renderers

  function renderLoading(msg) {
    const box = el('div', 'itr-box');
    const head = el('div', 'itr-head');
    head.append(el('span', 'itr-title', 'llmTranslate'), closeBtn());

    const body = el('div', 'itr-body itr-loading');
    const spinner = el('span', 'itr-spinner');
    statusLabelEl = el('span', '', `Checking ${msg.model || 'model'}…`);
    elapsedEl = el('span', 'itr-elapsed', '0s');
    body.append(spinner, statusLabelEl, elapsedEl);

    box.append(head, body);
    return box;
  }

  function renderStream(msg) {
    const box = el('div', 'itr-box');

    const head = el('div', 'itr-head');
    head.append(el('span', 'itr-title', `llmTranslate → ${msg.targetLang}`), closeBtn());

    const body = el('div', 'itr-body');
    streamTextEl = el('div', 'itr-text', '');
    body.append(streamTextEl);

    const foot = el('div', 'itr-foot');
    streamStateEl = el('span', 'itr-model itr-live', `Translating to ${msg.targetLang}…`);
    elapsedEl = el('span', 'itr-elapsed', `${Math.round((Date.now() - startedAt) / 1000)}s`);
    streamCopyBtn = el('button', 'itr-copy', 'Copy');
    streamCopyBtn.disabled = true; // enabled when the stream finishes
    streamCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentText);
        streamCopyBtn.textContent = 'Copied ✓';
        setTimeout(() => (streamCopyBtn.textContent = 'Copy'), 1500);
      } catch {
        streamCopyBtn.textContent = 'Copy failed';
      }
    });
    foot.append(streamStateEl, elapsedEl, streamCopyBtn);

    box.append(head, body, foot);
    return box;
  }

  function renderError(message) {
    const box = el('div', 'itr-box');
    const head = el('div', 'itr-head itr-head-error');
    head.append(el('span', 'itr-title', 'llmTranslate — error'), closeBtn());
    const body = el('div', 'itr-body');
    body.append(el('div', 'itr-text itr-error', message || 'Unknown error'));
    box.append(head, body);
    return box;
  }

  // --------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function closeBtn() {
    const b = el('button', 'itr-close', '✕');
    b.title = 'Close (Esc)';
    b.addEventListener('click', removePopup);
    return b;
  }

  function styleEl() {
    const s = document.createElement('style');
    s.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .itr-box {
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        font-size: 14px;
        line-height: 1.45;
        color: #1f2328;
        background: #ffffff;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .22);
        width: max-content;
        max-width: min(440px, calc(100vw - 32px));
        overflow: hidden;
        animation: itr-in .12s ease-out;
      }
      @keyframes itr-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
      .itr-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px;
        padding: 7px 10px 7px 12px;
        background: #f6f8fa;
        border-bottom: 1px solid #d0d7de;
      }
      .itr-head-error { background: #fff1f0; border-bottom-color: #ffccc7; }
      .itr-title { font-weight: 600; font-size: 12.5px; color: #57606a; white-space: nowrap; }
      .itr-close {
        all: unset; cursor: pointer; font-size: 12px; color: #57606a;
        padding: 2px 6px; border-radius: 6px; line-height: 1;
      }
      .itr-close:hover { background: rgba(0,0,0,.08); color: #1f2328; }
      .itr-body { padding: 12px 14px; }
      .itr-loading { display: flex; align-items: center; gap: 10px; color: #57606a; max-width: 360px; }
      .itr-spinner {
        width: 14px; height: 14px; flex: none;
        border: 2px solid #d0d7de; border-top-color: #0969da;
        border-radius: 50%;
        animation: itr-spin .7s linear infinite;
      }
      @keyframes itr-spin { to { transform: rotate(360deg); } }
      .itr-elapsed {
        font-size: 11px; color: #8c959f;
        font-variant-numeric: tabular-nums;
        flex: none; margin-left: auto;
      }
      .itr-text {
        white-space: pre-wrap;
        word-wrap: break-word;
        min-width: 180px;
        max-height: 320px;
        overflow: auto;
        user-select: text;
        cursor: text;
      }
      .itr-error { color: #cf222e; }
      .itr-foot {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px 8px 12px;
        border-top: 1px solid #eaeef2;
      }
      .itr-model {
        font-size: 11px; color: #8c959f;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        flex: 1;
      }
      .itr-live { color: #0969da; animation: itr-pulse 1.2s ease-in-out infinite; }
      @keyframes itr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
      .itr-copy {
        all: unset; cursor: pointer;
        font-family: inherit; font-size: 12px; font-weight: 600;
        color: #0969da; padding: 3px 10px; border-radius: 6px;
        white-space: nowrap; flex: none;
      }
      .itr-copy:hover:not(:disabled) { background: #ddf4ff; }
      .itr-copy:disabled { opacity: .4; cursor: default; }
      @media (prefers-color-scheme: dark) {
        .itr-box { color: #e6edf3; background: #161b22; border-color: #30363d; }
        .itr-head { background: #21262d; border-bottom-color: #30363d; }
        .itr-head-error { background: #3d1d1f; border-bottom-color: #6e2c2f; }
        .itr-title { color: #8b949e; }
        .itr-close { color: #8b949e; }
        .itr-close:hover { background: rgba(255,255,255,.12); color: #e6edf3; }
        .itr-loading { color: #8b949e; }
        .itr-spinner { border-color: #30363d; border-top-color: #58a6ff; }
        .itr-elapsed { color: #6e7681; }
        .itr-error { color: #ff7b72; }
        .itr-foot { border-top-color: #21262d; }
        .itr-model { color: #6e7681; }
        .itr-live { color: #58a6ff; }
        .itr-copy { color: #58a6ff; }
        .itr-copy:hover:not(:disabled) { background: rgba(56,139,253,.15); }
      }
    `;
    return s;
  }
})();
