# Google Forms Job Autofill

A Chrome extension (Manifest V3) that helps you fill in job-application
questions on Google Forms from a profile you save once, locally in your
browser. It detects a form's questions, proposes matches against your saved
profile, and — only after you explicitly review and confirm — fills in the
fields it's confident about. It never submits a form on your behalf.

## Project status

Phases 1 through 4 are implemented:

| Phase | Scope | Status |
|---|---|---|
| 1 | Extension scaffold, popup, options page, local profile storage | Implemented |
| 2 | Google Forms question detection and parsing | Implemented |
| 3 | Deterministic field matching and confirmation-gated autofill | Implemented |
| 4 | Expanded profile fields, local scan history, and aggregate insights | Implemented |

**Live browser verification status:** this extension has been tested against
a real Google Forms job application by hand, but not with an automated
browser-testing tool. Confirmed working live:
- Google Form detection and question scanning (Phase 2).
- Confirmation-gated autofill of three short-text fields — Current Company,
  Current Designation, and Total Full-Time Product Management Experience
  (Phase 3).

**Not yet confirmed in a live form:** radio and dropdown autofill, the
file-upload detection heuristic, and all of Phase 4's new profile fields and
matching rules. These are implemented and covered by mock-DOM/unit-style
checks written during development (see [Testing and validation](#testing-and-validation)),
but have not been exercised against a real Google Form yet. Treat them as
implemented-but-unverified until confirmed.

## Features

- Detects whether the current tab is a Google Form and reports its title.
- Parses a form's questions: text, type, required status, and available
  options (for choice-based questions).
- Matches parsed questions against a locally saved profile using
  deterministic keyword rules — not an AI or machine-learning matcher.
- Shows a review step listing exactly what would be filled before anything
  is written to the page.
- Fills only the fields you check and confirm; everything else is left for
  you to answer manually.
- Verifies each fill by reading the field back after writing it, rather than
  assuming a write succeeded.
- Learns which questions and fields recur across the forms you scan, stored
  and viewable entirely locally (see [Scan history and insights](#data-storage-and-privacy)).
- No network requests of any kind — everything runs and stays in your
  browser.

## Supported profile fields

All fields are optional; you can save a profile with only some of them
filled in.

| Category | Field (label) | Storage key | Input type |
|---|---|---|---|
| Personal | Full Name | `fullName` | text |
| Personal | Email | `email` | email |
| Personal | Phone Number | `phone` | tel |
| Location | Current Location | `currentLocation` | text |
| Location | Hometown | `hometown` | text |
| Professional | Current Company | `company` | text |
| Professional | Current Designation | `jobTitle` | text |
| Professional | Total Full-Time Experience (years) | `yearsExperience` | number |
| Professional | B2C Product Management Experience (years) | `b2cExperience` | number |
| Professional | B2B Product Management Experience (years) | `b2bExperience` | number |
| Professional | AI/GenAI Experience | `aiGenaiExperience` | textarea (free text) |
| Professional | LinkedIn URL | `linkedin` | url |
| Professional | Portfolio URL | `portfolio` | url |
| Employment | Official Notice Period | `noticePeriod` | select (fixed options) |
| Employment | Availability / Joining Date | `availability` | text |
| Compensation | Current CTC (₹ LPA) | `currentCtc` | number |
| Compensation | Expected CTC (₹ LPA) | `expectedCtc` | number |
| Career Details | Managed Product Area / Domain | `managedProductArea` | text |
| Career Details | Team Size Managed | `teamSize` | number |
| Career Details | People Management Experience | `peopleManagementExperience` | text |
| Career Details | Highest Education | `highestEducation` | text |
| Career Details | College / Institution | `collegeInstitution` | text |
| Application-Specific | Willing to Relocate | `willingToRelocate` | select (Yes / No) |
| Application-Specific | Preferred Work Location | `preferredWorkLocation` | text |
| Application-Specific | Work Authorization | `workAuthorization` | text |

Notes:
- **Current CTC and Expected CTC are separate fields** (`currentCtc` /
  `expectedCtc`) with matching rules that explicitly exclude each other, so
  a question about one is never answered with the other's value.
- **B2C and B2B experience are separate fields** (`b2cExperience` /
  `b2bExperience`), distinct from overall `yearsExperience`.
- `willingToRelocate` is the one deliberately structured Yes/No field. It is
  still only ever applied through the same exact-option-match rule as any
  other choice question (see below) — it is not a special-cased shortcut.
- `aiGenaiExperience` is free text and is only usable for text-type
  questions; it cannot be used to answer a Yes/No question, since free text
  can't exactly match a "Yes"/"No" option.

## Supported question types and autofill behavior

| Type | Detected | Autofilled | Notes |
|---|---|---|---|
| `short_text` | Yes | Yes | Native input value set; `input`/`change`/`blur` events dispatched. |
| `paragraph` | Yes | Yes | Same mechanism as `short_text`, targeting a `<textarea>`. |
| `radio` | Yes | Only on an **exact** option match | The proposed value must exactly equal (case/whitespace-insensitive) one visible option label. No partial or "closest" match is ever selected. |
| `dropdown` | Yes | Only on an **exact** option match | Same exact-match rule as radio. If a dropdown's options are only rendered after it's opened, they may not be visible to the parser; such questions are flagged for manual review rather than guessed. |
| `checkbox` | Yes | **No** | Detected and classified, but not implemented as an autofill target in this phase; always flagged as unsupported for autofill. An associated free-text "Other" input is captured by the parser for future use but is not currently filled. |
| `date` | Yes (heuristic) | **No** | Detected via `aria-label` hints (e.g. "Day"/"Month"/"Year"); not implemented as an autofill target. |
| `file_upload` | Yes (heuristic) | **No — never automated** | Always routed to manual review. The extension does not select, attach, or upload any file. |
| `unknown` | Fallback | **No** | Used when no recognizable control is found; always flagged for manual review rather than causing an error. |

Every matched question also carries a **status** — `matched`,
`needs_review`, `unmatched`, or `unsupported` — and a numeric confidence
score, both shown in the review panel and logged (in more detail) to the
Google Form page's own DevTools console.

## How it works

1. **Save your profile** — open the extension's options page and fill in
   whichever fields apply to you. Leave the rest blank.
2. **Open a Google Form** job application in a tab.
3. **Scan the form** — click the extension icon, then **Scan Form**. This
   parses the form's questions and immediately matches them against your
   saved profile; nothing is written to the page yet.
4. **Review detected and matched fields** — the popup shows counts
   (matched / needs review / unsupported / unmatched). Click **Review &
   Autofill** to see the exact list: each confidently matched field is
   shown with a checkbox and its proposed value; everything else is shown
   read-only with the reason it wasn't auto-matched.
5. **Confirm autofill** — uncheck anything you don't want filled, then click
   **Confirm & Fill**. Only the checked, already-`matched` fields are
   written to the page. Each one is verified after writing and shown with a
   ✓ (filled and verified) or ✗ (not confirmed, with an error message) in
   the popup.
6. **Manually handle unsupported fields** — questions marked `needs_review`,
   `unmatched`, or `unsupported` (including checkboxes, dates, and file
   uploads) are never filled automatically. Answer and submit those — and
   review everything else — yourself, directly on the form.

## Installation

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the project's root folder (`google-forms-job-autofill`).

After editing any file, return to `chrome://extensions` and click the
refresh icon on the extension's card. For content-script changes, also
reload the Google Form tab you're testing on.

No build step is required — this is plain JavaScript, HTML, and CSS with no
bundler or npm dependencies.

## Usage instructions

- Click the toolbar icon on any tab to check whether it's recognized as a
  Google Form.
- Use **Open Profile** to add or update your saved profile at any time.
- Use **Scan Form** on a job-application Google Form to parse and match its
  questions.
- Use **Review & Autofill** → **Confirm & Fill** to fill in only the fields
  you approve.
- Open the options page's **Scan Insights** section to see which questions
  and fields have come up most often across the forms you've scanned, and
  which ones frequently go unmatched — useful for deciding what to add to
  your profile next.
- Use **Clear Scan History** (in the options page) to delete all locally
  stored scan history; you'll be asked to confirm before anything is
  deleted. This does not affect your saved profile.

## Project structure

```
google-forms-job-autofill/
├── manifest.json           # Manifest V3 config: popup, options page, background
│                           # service worker, content script, "storage" permission only
├── background.js           # Minimal service worker (install/update logging only)
├── content/
│   ├── content.js          # Message handling, scan/match orchestration, scan-history
│   │                       # saving, and the confirmation-gated autofill executor
│   ├── formParser.js       # Google Form detection and question extraction (DOM-only)
│   └── fieldMatcher.js     # Pure, DOM-free keyword matching against the saved profile
├── popup/
│   ├── popup.html
│   ├── popup.js            # Scan/match summary, review panel, confirm-and-fill flow
│   └── popup.css
├── options/
│   ├── options.html        # Profile form (grouped fieldsets) + Scan Insights section
│   ├── options.js          # Profile load/save, insights rendering, clear-history action
│   └── options.css
├── shared/
│   └── storage.js          # chrome.storage.local wrapper: profile CRUD, scan-history
│                           # storage with retention, and insight aggregation
└── icons/
    └── README.md           # No icon files exist yet; Chrome uses its default icon
```

## Data storage and privacy

Everything this extension stores lives in `chrome.storage.local`, scoped to
your own browser profile. There are no external servers, accounts, or
network requests anywhere in the codebase (verified: no `fetch`,
`XMLHttpRequest`, or similar network APIs are used).

Two storage keys are used:

- **`jobAutofillProfile`** — the profile you fill in on the options page,
  stored as-is (whatever you type is what's saved). If you enter sensitive
  values here (for example, compensation figures), they're stored locally
  and used only to propose autofill values — but you should still avoid
  entering anything you wouldn't want persisted in your browser's local
  storage, since this extension does not encrypt profile data at rest.
- **`jobAutofillScanHistory`** — a locally kept record of past scans, used
  to compute the Scan Insights shown in the options page. Each record
  contains: a scan ID, the form's title, a timestamp, a question count, and
  a sanitized list of that scan's questions (question text, type, required
  flag, the *name* of any matched profile field, and its match status).
  **It never contains your actual profile values, proposed answers, email
  address, phone number, or any uploaded file.** Question and form-title
  text are truncated to 300 characters as a storage-size safeguard.

Retention: scan history is capped at the **100 most recent scans**. If you
scan the same form again without it changing, that scan updates the most
recent matching record in place rather than adding a new one, so repeated
clicks don't inflate the history.

You can clear all scan history at any time from the options page (with a
confirmation prompt). Uninstalling the extension removes all of its stored
data, per Chrome's standard extension storage behavior.

## Testing and validation

**No automated test suite is currently committed to this repository** —
there is no `package.json`, test runner, or `tests/` directory in the
project tree.

During development, the following validation was performed, but is not
preserved as a repeatable, in-repo test suite:

- **Static validation**: `manifest.json` parsed as valid JSON; every
  JavaScript file passed `node --check` (syntax validation only).
- **Mock-DOM and pure-logic checks**: ad hoc Node.js scripts (using `jsdom`
  for DOM-dependent code, and plain Node for the DOM-free
  `content/fieldMatcher.js` and `shared/storage.js` logic) were used during
  development to exercise question extraction, field matching, the
  autofill DOM-write/verification mechanics, and scan-history/insights
  behavior against hand-built fixtures. These were run from a temporary
  location outside this repository and are not included here.
- **Live browser testing**: performed manually by the maintainer against a
  real Google Forms job application — see [Project status](#project-status)
  for exactly what has and hasn't been confirmed this way.

If you contribute changes, consider adding a real test suite (see
[Roadmap](#roadmap)) so validation is reproducible from a clean checkout.

## Known limitations

- Radio and dropdown autofill, the file-upload heuristic, and all Phase 4
  profile fields/matching rules are implemented but not yet confirmed
  against a live Google Form.
- Dropdown options that Google Forms only renders after the dropdown is
  opened may not be visible to the parser; such questions are flagged for
  manual review rather than filled with a guess.
- Question IDs are stable only within a single scan/page session — they are
  not meant to, and do not, persist across page reloads or different forms.
- Field matching is deterministic keyword/regex matching, not semantic or
  AI-based; a question phrased very differently from the built-in rules may
  not be recognized.
- Checkbox and date questions are detected and classified but are not
  autofill targets in this phase.
- No custom extension icon is included yet; Chrome shows its default icon.
- Scan-history growth is bounded (100 scans), but very large individual
  scans (many questions) are not separately size-limited beyond per-field
  text truncation.

## Safety principles

These are enforced in the current implementation, not just intended:

- **Confirmation before autofill** — the popup's review panel is a separate
  step from scanning; nothing is written to the page until you explicitly
  click Confirm & Fill on checked fields.
- **No automatic form submission** — no code path in this extension calls
  a form's submit method or clicks a submit control.
- **No guessing when matching fields** — a missing profile value, an
  ambiguous question, or a choice question without an exact option match
  is flagged (`needs_review` or `unmatched`), never filled with a
  placeholder or a best guess.
- **Manual review for unsupported or uncertain fields** — file uploads,
  checkboxes, date fields, and anything the matcher can't confidently
  resolve are always left for you to complete yourself.
- **Yes/No questions are never inferred from unrelated free text** — the
  one deliberately structured Yes/No profile field (`willingToRelocate`)
  is still only ever applied via the same exact-option-match rule as any
  other choice question; free-text fields like `aiGenaiExperience` cannot
  satisfy a Yes/No question.

## Roadmap

The following are potential future improvements only — **none of them are
implemented**:

- A committed, repeatable automated test suite (unit tests for matching and
  parsing, plus a documented live-browser verification checklist).
- Browser-driven end-to-end testing against real Google Forms.
- Support for filling checkbox and date questions.
- A custom extension icon.
- Surfacing more of the computed insight data (type frequency, matched-field
  frequency, required-question frequency) directly in the options page UI,
  beyond the current frequent/unmatched/needs-review lists.
- Configurable scan-history retention.

## License

No license file is present in this repository, and no license has been
specified yet.
