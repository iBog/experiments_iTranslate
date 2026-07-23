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

## Notes

- Works on normal web pages; Chrome blocks content scripts on `chrome://` pages and the Web Store.
- Thinking-model output (`<think>…</think>` blocks from deepseek-r1, qwen3, …) is stripped automatically.
- Recommended model for translation: `gemma4:e4b` (`ollama pull gemma4:e4b`).
