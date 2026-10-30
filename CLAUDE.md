# llmTranslate — notes for agents

Chrome extension (Manifest V3): select text → right-click → translation from the user's own
Ollama server, shown in a popup at the cursor. Published in the Chrome Web Store as
**llmTranslate — Ollama Translator**, item ID `efdbloclcpmhimjmmpjfbbhfbbkhooca`.
Plain JavaScript, no build step, no dependencies, no `package.json`.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions, content script, version (single source of the version) |
| `background.js` | Service worker: context menu, preflight probe, streaming `/api/chat`, error payloads |
| `ollama.js` | Shared pure helpers: `probeOllama`, `findModel`, `isLocalUrl`, `stripThinking`, `fetchWithTimeout` |
| `content.js` | Popup in a closed Shadow DOM at the last right-click position; all UI states |
| `options.html/.js/.css` | Settings page (toolbar icon opens it): URL, model, target language, keep-alive |
| `tests/ollama.test.js` | `node --test` tests of `ollama.js` |
| `docs/PRIVACY.md` | Privacy policy (linked from the store listing) |
| `docs/store-privacy-practices.md` | Copy-paste answers for the Web Store "Privacy practices" tab |

`ollama.js` is a classic script, not a module: the worker loads it with
`importScripts('ollama.js')`, `options.html` with a `<script>` tag before `options.js`, the tests
with `vm`. Keep it free of `chrome.*` calls so it stays testable in Node.

## Message protocol (background ⇄ content)

Background → content, always with `{ frameId }` of the frame where the text was selected:
`llmtranslate-loading` → `-status` (`phase`: connecting / loading-model / starting / thinking /
translating) → `-progress` (streamed text, throttled to 80 ms) → `-result`, or `-error`
(`title`, `message`, optional `steps`, `command`, `link`, `models`, `canRetry`).

Content → background: `llmtranslate-retry`, `-use-model`, `-open-options`, `-cancel`.

Invariants that earlier bugs came from:

- **Cancel.** One `AbortController` per tab in `active`; a new translation aborts the old one.
  User dismissal (Esc, ✕, outside click) calls `dismiss()` → sends `-cancel`; `content.js` then
  drops every message until the next `-loading`. `removePopup()` alone must not cancel — it
  also runs when one popup replaces another.
- **Service worker dies after ~30 s idle.** Nothing that must survive (last selected text for
  Retry) lives in worker memory — it goes to `chrome.storage.session` under `req:<tabId>`.
- **Stale tabs.** Tabs opened before install/update have no live content script. `deliver()`
  injects `content.js` with `chrome.scripting.executeScript` and resends; where injection is
  forbidden (`chrome://`, Web Store, PDF viewer) the action gets a `!` badge. A freshly
  injected script has not seen the right-click, so that popup opens at the viewport centre.
- **Stalled stream.** `streamChat` aborts after `STREAM_IDLE_MS` (3 min) without a chunk; the
  limit is long because a cold model load sends nothing until the model is in memory.
- `<think>…</think>` output of reasoning models is stripped, including a still-open block.

## Permissions and the Web Store

- Current: `contextMenus`, `storage`, `scripting`, host `<all_urls>`, content script on
  `<all_urls>` with `all_frames: true`.
- **Every permission must be actively used.** The store flagged 1.0.0 ("Purple Potassium") for
  requesting `scripting` without using it. `activeTab` and `scripting` were dropped in 1.0.1;
  `scripting` came back in 1.0.2 for the stale-tab injection. Adding or removing a permission
  means updating its justification in `docs/store-privacy-practices.md` in the same change.
- `chrome.tabs.sendMessage` / `tabs.onRemoved` do not need the `tabs` permission — don't add it.
- `<all_urls>` host access is needed for the user-configured Ollama URL and for the popup on
  any site. Narrowing it (localhost-only + `optional_host_permissions`) is a possible future step.
- Ollama must allow the extension's origin. Commands shown to users use the exact origin
  `chrome-extension://${chrome.runtime.id}`, never `chrome-extension://*` (that would open the
  user's Ollama to every installed extension). An unpacked copy has a different ID; the
  settings page always shows the right command.

## Conventions

- UI text is English. No frameworks, no bundler, no npm dependencies.
- Shared logic goes into `ollama.js` — don't duplicate helpers between `background.js` and
  `options.js`.
- Line endings are mixed (`background.js`, `options.js`, `ollama.js` are LF; `content.js`,
  `manifest.json`, `options.html`, `README.md`, docs are CRLF). Preserve each file's style.
- Error popups must stay actionable: say what is wrong and give the fix (steps, a copyable
  command, a model picker, Retry).

## Verify

- `node --test` — tests for `ollama.js`.
- `node --check <file>.js` for syntax; `manifest.json` must parse as JSON.
- Real check: `chrome://extensions` → Developer mode → **Load unpacked** this folder, then
  reload the extension after every change. Worth covering by hand: settings page connects;
  translate on a normal page and inside an iframe; close the popup mid-stream (it must not
  come back); translate in a tab opened before the reload; Retry after waiting > 30 s.

## Release

1. Bump `version` in `manifest.json` — the store rejects a re-upload of the same version.
2. `node --test`.
3. Build the zip from an explicit allowlist (never zip the folder — that would ship `.git`,
   `CLAUDE.md`, `README.md`, `docs/`, `tests/`):
   ```powershell
   Compress-Archive -Force -Path manifest.json, background.js, ollama.js, content.js, options.html, options.js, options.css, icons -DestinationPath llmtranslate-<version>.zip
   ```
   A new runtime file must be added to this list here and in `README.md`. Zips are gitignored.
4. Developer Dashboard → Package → upload; refresh the Privacy practices answers from
   `docs/store-privacy-practices.md`; Submit for review.
5. Store screenshots live in `docs/`, not `icons/` — anything under `icons/` is packaged.

## Git

- Commit only when asked. No AI co-author lines or "generated with" notes in commits or files.
