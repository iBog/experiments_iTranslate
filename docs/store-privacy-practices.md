# Chrome Web Store — Privacy practices tab answers

Copy-paste texts for the developer console. After filling these in, tick the
data-usage certification checkbox and **Save Draft**.

> Note: the `activeTab` and `scripting` justifications requested by the console
> disappear after uploading a package built from the current `manifest.json` —
> those permissions were removed as unused.

---

## Single purpose description

> llmTranslate has a single purpose: translating user-selected text on web
> pages. The user selects text, right-clicks and chooses "llmTranslate"; the
> selected text is translated into the user's chosen language by a large
> language model running locally on the user's own computer (an Ollama server
> configured by the user), and the result is shown in a small popup at the
> cursor position. No data is sent to the developer or any third party.

---

## Permission justifications

### contextMenus

> The extension's only entry point is a "llmTranslate" item in the right-click
> context menu, shown when text is selected. It is required so the user can
> trigger translation of the selected text.

### storage

> Stores the user's settings only: the URL of their local Ollama server, the
> selected model name, the target language, and the model keep-alive duration.
> No browsing data or personal data is stored.

### Host permission use (`<all_urls>`)

> Required for two reasons: (1) the content script must be able to display the
> translation popup on any website where the user selects text — translation
> must work on arbitrary sites; (2) the extension must fetch the translation
> from the user's own Ollama server, whose URL is user-configured (default
> http://localhost:11434, but users may run Ollama on another host/port on
> their local network). The extension only ever connects to that single
> user-configured server; it makes no other network requests and sends no data
> to the developer or third parties.

### Remote code use

Select **"No, I am not using remote code"**.

> All executable code is contained in the extension package. The extension
> does not use eval, does not load external scripts, and does not execute any
> remotely hosted code. Network requests are made only to the user's own local
> Ollama server and exchange plain JSON data (model lists and translation
> text), never code.

---

## Data usage section

- Check **none** of the data-type checkboxes (the extension collects no data).
- Certify compliance with the Developer Program Policies (final checkbox).

## Privacy policy URL

Use the raw file from this repository (or a GitHub Pages URL if enabled):

```
https://github.com/iBog/experiments_iTranslate/blob/main/docs/PRIVACY.md
```
