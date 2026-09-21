# Google Forms Job Autofill

A Chrome extension (Manifest V3) that autofills job application fields on
Google Forms from a profile you save once, locally.

## Status

Phase 1: project scaffolding. The extension installs, detects whether the
current tab is a Google Form, and lets you save/edit a profile. Scanning a
form's individual questions and autofilling them is **not implemented yet**.

## Project structure

```
google-forms-job-autofill/
├── manifest.json
├── background.js
├── content/
│   ├── content.js         # Detects Google Forms pages, answers popup status requests
│   ├── formParser.js      # Page/title detection (question parsing: not yet implemented)
│   └── fieldMatcher.js    # Scaffolded only; no matching logic yet
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
├── shared/
│   └── storage.js         # chrome.storage.local wrapper (get/save/clear profile)
└── icons/
    └── README.md          # no icon files yet; see note inside
```

## Build system

None. This is plain JS/HTML/CSS with no bundler, transpiler, or npm
dependencies — Chrome loads the files as-is. Keeping it dependency-free is
the simplest maintainable setup for a project this size; a build step can be
introduced later if the codebase grows enough to need modules/bundling.

## Loading the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this project's root folder (`google-forms-job-autofill`).
5. The extension icon appears in the toolbar (Chrome's default icon, since
   no custom icon is set yet — see `icons/README.md`).

After editing any file, return to `chrome://extensions` and click the
refresh icon on the extension's card to reload it. For content script
changes, also reload the Google Forms tab you're testing on.

## Using it (current functionality)

- Click the toolbar icon to open the popup. It reports whether the active
  tab is a Google Form and shows the form's title if so.
- **Scan Form** re-checks the current tab's status.
- **Autofill** is disabled — it will be enabled once form scanning and field
  matching are implemented.
- **Open Profile** opens the options page, where you can enter and save:
  Full Name, Email, Phone Number, Current Company, Current Job Title, Total
  Years of Experience, LinkedIn URL, and Portfolio URL. Saved data persists
  in `chrome.storage.local` and reloads automatically next time you open the
  options page.

## Required Chrome permissions

- `storage` — required to save and read your profile via
  `chrome.storage.local`.

No host permissions beyond the static content-script match
(`https://docs.google.com/forms/*`) are requested, and no network requests
are made — all data stays local to your browser.

## Current limitations

- Form question parsing is not implemented (`formParser.js` only detects
  that a page is a Google Form and reads its title).
- Field matching is not implemented (`fieldMatcher.js` is an empty
  scaffold).
- The Autofill button is intentionally disabled; there is no autofill
  behavior yet.
- No icon files are included; Chrome shows its default extension icon.
- No automated test suite yet; validation so far is manifest JSON
  well-formedness and JS syntax checks (see below).

## Validation performed

- `manifest.json` parsed successfully as valid JSON.
- All `.js` files pass `node --check` (syntax validation).
