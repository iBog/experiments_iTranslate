# iTranslate — Ollama Translator (Chrome Extension)

Translate selected text on any website with a **local Ollama LLM**.
Select text → right-click → **iTranslate** → translation appears in a popup at your cursor.

## Features

- Context-menu translation of any selected text
- Uses your local [Ollama](https://ollama.com) server — nothing leaves your machine
- Settings page:
  - Ollama connection URL (default `http://localhost:11434`)
  - Model dropdown auto-populated from the server (`/api/tags`)
  - Target language dropdown (top 41 languages)
- Result popup at the cursor position, with Copy button, dark-mode support, Esc/click-outside to dismiss

## Setup

### 1. Allow Chrome extensions to call Ollama (one-time)

Ollama rejects requests from browser extensions unless you allow their origin:

**Windows** (then restart Ollama from the tray / `ollama serve`):
```powershell
setx OLLAMA_ORIGINS "chrome-extension://*"
```

**macOS / Linux:**
```bash
export OLLAMA_ORIGINS="chrome-extension://*"   # or launchctl setenv / systemd override
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and pick this folder

### 3. Configure

1. Click the extension icon (opens the settings page)
2. Enter the Ollama URL (default `http://localhost:11434`) → **Connect**
3. Pick a model and a target language → **Save settings**

### 4. Use it

Select text on any page → right-click → **iTranslate "…"** → the translation pops up at your cursor.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Context menu + Ollama API calls (`/api/chat`) |
| `content.js` | Cursor tracking + popup UI (Shadow DOM) |
| `options.html/js/css` | Settings page |
| `icons/` | Extension icons |

## Releasing

### Chrome Web Store (for regular users)

Chrome blocks non-store `.crx` installs on Windows/macOS, so the Web Store is the only
way to reach non-technical users.

1. **Register** as a developer at the
   [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)
   (one-time $5 fee).
2. **Bump the version** in `manifest.json` (e.g. `1.0.1`) — the store rejects re-uploads
   of the same version.
3. **Build the package** — zip only the extension files (no `.git`, no README):
   ```powershell
   Compress-Archive -Force -Path manifest.json, background.js, content.js, options.html, options.js, options.css, icons -DestinationPath itranslate-1.0.0.zip
   ```
4. **Create the listing** in the dev console:
   - Description — mention it requires a locally running [Ollama](https://ollama.com)
   - At least one screenshot (1280×800 or 640×400) and a small promo tile (440×280)
   - Category: Productivity / Tools
5. **Privacy declarations:**
   - Justify permissions: content script needs `<all_urls>` to show the popup on any
     site; network requests go only to the user-configured local Ollama URL
   - Data usage: the extension collects nothing — selected text is sent only to the
     user's own local server
   - Provide a privacy policy URL (a simple GitHub page stating "all processing is
     local" is enough)
6. **Submit for review.** Broad host permissions usually mean a manual review —
   expect a few days up to ~2 weeks for the first submission. Publishing as
   **Unlisted** first is a good soft launch.

### GitHub release (for developers)

Ollama users are technical — "Load unpacked" works fine for them:

1. Tag and push: `git tag v1.0.0 && git push --tags`
2. Create a GitHub release from the tag and attach the zip from step 3 above
3. Users download, unzip, and install via `chrome://extensions` → Developer mode →
   **Load unpacked** (see Setup above)

## Notes

- Works on normal web pages; Chrome blocks content scripts on `chrome://` pages and the Web Store.
- Thinking-model output (`<think>…</think>` blocks from deepseek-r1, qwen3, …) is stripped automatically.
- Recommended model for translation: `gemma4:e4b` (`ollama pull gemma4:e4b`).
