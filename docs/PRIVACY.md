# Privacy Policy — llmTranslate

_Last updated: July 23, 2026_

llmTranslate is a Chrome extension that translates selected text using a large
language model (LLM) running **locally on your own computer** via
[Ollama](https://ollama.com).

## Data collection

**llmTranslate does not collect, store, transmit, sell, or share any user data.**

- The text you select for translation is sent **only** to the Ollama server
  address that you configure yourself (by default `http://localhost:11434`,
  i.e. your own machine). It is never sent to the extension developer or to
  any third party.
- Translations are displayed on screen and are not logged or retained by the
  extension.
- The extension has no analytics, no telemetry, no tracking, and no accounts.

## What is stored

The extension stores only its own settings, using Chrome's extension storage
(`chrome.storage.sync`):

- the Ollama server URL you entered,
- the name of the model you selected,
- the target language you selected,
- the "keep model alive" duration you selected.

These settings may be synchronized between your own Chrome browsers by
Chrome Sync (a Google Chrome feature controlled by your browser settings).
No other data is stored.

## Network access

The extension makes network requests exclusively to the Ollama server URL
configured by you, to:

- list installed models (`/api/tags`),
- check whether a model is loaded (`/api/ps`),
- perform translations (`/api/chat`).

No other network requests are made.

## Changes

Any changes to this policy will be published in this repository.

## Contact

Questions: open an issue at
<https://github.com/iBog/experiments_iTranslate/issues>
