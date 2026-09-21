// Content script entry point.
//
// Page detection and status reporting, on-demand question extraction, field
// matching, and confirmation-gated autofill execution.
//
// Flow: JOBAUTOFILL_SCAN_FORM extracts questions (formParser.js) and
// immediately matches them against the saved profile (fieldMatcher.js) —
// matching is pure data computation, not a page write, so running it
// automatically after a scan is safe and keeps the popup's state simple.
// Nothing is written to the page until the user explicitly confirms via
// JOBAUTOFILL_APPLY_AUTOFILL, which only fills questions that are (a) in
// the caller-provided id list AND (b) independently re-verified here as
// status "matched" — the content script never trusts the message alone.
//
// DOM element references (inputElements/optionElements/containerElement)
// live only in this script's in-memory caches and are never sent through
// chrome.runtime messaging; only plain serializable data crosses that
// boundary. This script never submits the form or clicks anything other
// than the specific option/control elements it was asked to fill.

(function () {
  let lastExtractedQuestions = [];
  let lastQuestionsById = new Map();
  let lastMatchesById = new Map();
  const DOM_READY_TIMEOUT_MS = 4000;

  function getStatus() {
    const isGoogleForm = window.JobAutofillFormParser.isGoogleFormPage();
    const formTitle = isGoogleForm ? window.JobAutofillFormParser.getFormTitle() : null;
    return { isGoogleForm, formTitle };
  }

  // Resolves as soon as at least one question container is found, or after
  // the timeout elapses — whichever comes first. Never polls forever and
  // never re-arms itself, so it can't create a runaway observer.
  function waitForQuestions(timeoutMs) {
    return new Promise((resolve) => {
      if (window.JobAutofillFormParser.hasAnyQuestionContainer()) {
        resolve();
        return;
      }
      let settled = false;
      const observer = new MutationObserver(() => {
        if (!settled && window.JobAutofillFormParser.hasAnyQuestionContainer()) {
          finish();
        }
      });
      const timer = setTimeout(finish, timeoutMs);

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Public schema only — no DOM element references, since those can't cross
  // the chrome.runtime messaging boundary (structured clone drops/rejects
  // them).
  function toPublicSchema(q) {
    return {
      id: q.id,
      originalText: q.originalText,
      normalizedText: q.normalizedText,
      type: q.type,
      required: q.required,
      options: q.options,
      status: q.status,
      confidence: q.confidence,
      domIndex: q.domIndex,
    };
  }

  function logQuestions(questions) {
    console.groupCollapsed(`[Job Autofill] Extracted ${questions.length} question(s)`);
    console.table(
      questions.map((q) => ({
        domIndex: q.domIndex,
        type: q.type,
        required: q.required,
        status: q.status,
        confidence: q.confidence,
        originalText: q.originalText,
        optionCount: q.options.length,
      }))
    );
    questions.forEach((q) => {
      if (q.options.length) {
        console.log(`  Options for "${q.originalText}":`, q.options);
      }
      if (q.status === 'needs_review') {
        console.warn(`  Needs review (${q.type}, confidence ${q.confidence}): "${q.originalText}"`, q.containerElement);
      }
    });
    console.groupEnd();
  }

  function logMatches(matches) {
    console.groupCollapsed(`[Job Autofill] Matched ${matches.length} question(s) against profile`);
    console.table(
      matches.map((m) => ({
        status: m.status,
        matchedField: m.matchedField,
        confidence: m.confidence,
        questionText: m.questionText,
        proposedValue: m.proposedValue,
        reason: m.reason,
      }))
    );
    console.groupEnd();
  }

  function summarizeMatches(matches) {
    const summary = { total: matches.length, matched: 0, needsReview: 0, unsupported: 0, unmatched: 0 };
    matches.forEach((m) => {
      if (m.status === 'matched') summary.matched += 1;
      else if (m.status === 'needs_review') summary.needsReview += 1;
      else if (m.status === 'unsupported') summary.unsupported += 1;
      else if (m.status === 'unmatched') summary.unmatched += 1;
    });
    return summary;
  }

  async function matchForm(questions) {
    let profile = null;
    try {
      profile = await JobAutofillStorage.getProfile();
    } catch (err) {
      console.error('[Job Autofill] Failed to load profile for matching:', err);
    }
    return window.JobAutofillFieldMatcher.matchQuestions(questions, profile);
  }

  // Saves a sanitized record of this scan for the local knowledge base
  // (see shared/storage.js). Never includes proposedValue or any actual
  // profile value — only question text/type/required/matchedField-name/
  // status, which is what's needed to learn which questions and fields
  // recur across applications. Storage errors are logged and swallowed so
  // a local-storage hiccup never breaks the scan/match result the popup is
  // waiting on.
  async function saveScanRecord(questions, matches, formTitle) {
    try {
      const matchesById = new Map(matches.map((m) => [m.questionId, m]));
      await JobAutofillStorage.addScanRecord({
        formTitle: formTitle || null,
        scannedAt: new Date().toISOString(),
        questionCount: questions.length,
        questions: questions.map((q) => {
          const match = matchesById.get(q.id);
          return {
            questionId: q.id,
            originalText: q.originalText,
            normalizedText: q.normalizedText,
            type: q.type,
            required: q.required,
            matchedField: match ? match.matchedField : null,
            status: match ? match.status : q.status,
          };
        }),
      });
    } catch (err) {
      console.error('[Job Autofill] Failed to save scan history (non-fatal, scan result is unaffected):', err);
    }
  }

  async function scanForm() {
    if (!window.JobAutofillFormParser.isGoogleFormPage()) {
      return { isGoogleForm: false, questions: [], matches: [], summary: null };
    }
    await waitForQuestions(DOM_READY_TIMEOUT_MS);
    const questions = window.JobAutofillFormParser.extractQuestions();
    lastExtractedQuestions = questions;
    lastQuestionsById = new Map(questions.map((q) => [q.id, q]));
    logQuestions(questions);

    const matches = await matchForm(questions);
    lastMatchesById = new Map(matches.map((m) => [m.questionId, m]));
    logMatches(matches);

    await saveScanRecord(questions, matches, window.JobAutofillFormParser.getFormTitle());

    return {
      isGoogleForm: true,
      questions: questions.map(toPublicSchema),
      matches,
      summary: summarizeMatches(matches),
    };
  }

  // --- Autofill execution -------------------------------------------------
  // Only ever called for ids the user checked in the popup's review step,
  // and only ever acts on a question independently re-confirmed here as
  // status "matched". No code path in this section calls form.submit(),
  // clicks a submit control, or touches any element other than the
  // specific input/option/listbox located for the target question.
  //
  // Every fill is verified, not assumed: after writing, the actual DOM
  // state is read back and compared against what was intended, and that
  // comparison — not the mere fact that a click/setter call didn't throw —
  // is what decides `filled`. Console logs describe *what happened*
  // (element found? write attempted? verified?) without printing raw
  // profile values — see maskForLog.

  function maskForLog(value) {
    if (value === null || value === undefined) return String(value);
    const str = String(value);
    if (str.length === 0) return '(empty)';
    if (str.length <= 2) return '*'.repeat(str.length);
    return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]} (${str.length} chars)`;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Some widgets validate/format on blur (e.g. phone number masking);
    // dispatching it is low-risk and may help Google's own JS pick up the
    // change even if input/change alone don't.
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // Re-locates a question's live input if the cached reference has gone
  // stale (Google Forms can re-render a question's DOM subtree between
  // scan and fill). Falls back to re-querying inside the cached container
  // using the same shape the parser itself looks for.
  function locateTextInput(question) {
    const cached = question.inputElements[0];
    if (cached && document.contains(cached)) {
      return { element: cached, relocated: false };
    }
    const container = question.containerElement;
    if (!container || !document.contains(container)) {
      return { element: null, relocated: false };
    }
    const relocated = container.querySelector('textarea') || container.querySelector('input[type="text"]');
    return { element: relocated || null, relocated: Boolean(relocated) };
  }

  function locateRadioOption(question, value) {
    const cached = question.optionElements.find((o) => o.label === value);
    if (cached && cached.element && document.contains(cached.element)) {
      return { element: cached.element, relocated: false };
    }
    const container = question.containerElement;
    if (!container || !document.contains(container)) return { element: null, relocated: false };
    const group = container.querySelector('[role="radiogroup"]');
    if (!group) return { element: null, relocated: false };
    const found = Array.from(group.querySelectorAll('[role="radio"]')).find((el) => {
      const label = (el.getAttribute('data-value') || el.getAttribute('aria-label') || el.textContent || '').trim();
      return label === value;
    });
    return { element: found || null, relocated: Boolean(found) };
  }

  function locateDropdownParts(question, value) {
    let listbox = question.inputElements[0];
    if (!listbox || !document.contains(listbox)) {
      const container = question.containerElement;
      listbox = container && document.contains(container) ? container.querySelector('[role="listbox"]') : null;
    }
    if (!listbox) return { listbox: null, option: null, relocated: false };

    const cachedOption = question.optionElements.find((o) => o.label === value);
    if (cachedOption && cachedOption.element && document.contains(cachedOption.element)) {
      return { listbox, option: cachedOption.element, relocated: false };
    }

    const owns = (listbox.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
    const candidates = owns.length
      ? owns.map((id) => document.getElementById(id)).filter(Boolean)
      : Array.from(document.querySelectorAll('[role="option"]'));
    const found = candidates.find((el) => {
      const label = (el.getAttribute('data-value') || el.getAttribute('aria-label') || el.textContent || '').trim();
      return label === value;
    });
    return { listbox, option: found || null, relocated: true };
  }

  function fillTextLike(question, value, log) {
    log('Locating target text input...');
    const { element, relocated } = locateTextInput(question);
    if (!element) {
      log('RESULT: target NOT found (cached reference gone and re-query in container failed).');
      return { targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Input element could not be located on the page.' };
    }
    log(`Target found${relocated ? ' by re-querying the container (cached reference was stale)' : ' via cached reference'}.`);

    log(`Applying native value setter (writing ${maskForLog(value)})...`);
    try {
      setNativeValue(element, value);
    } catch (err) {
      log('Native value setter threw an error:', err);
      return { targetFound: true, writeAttempted: false, valueAfterWrite: element.value, filled: false, error: `Failed to set value: ${String(err)}` };
    }
    log('input/change/blur events dispatched. Reading back the live value to verify...');

    const valueAfterWrite = element.value;
    const filled = valueAfterWrite === value;
    log(`Verification: read back ${maskForLog(valueAfterWrite)} — ${filled ? 'MATCHES' : 'DOES NOT MATCH'} expected value.`);

    return {
      targetFound: true,
      writeAttempted: true,
      valueAfterWrite,
      filled,
      error: filled ? undefined : 'Value read back after write does not match the proposed value.',
    };
  }

  function fillRadio(question, value, log) {
    log('Locating target radio option...');
    const { element, relocated } = locateRadioOption(question, value);
    if (!element) {
      log('RESULT: target radio option NOT found.');
      return { targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Matching radio option could not be located on the page.' };
    }
    log(`Target found${relocated ? ' by re-querying the container' : ' via cached reference'}. Clicking it...`);
    element.click();

    const ariaChecked = element.getAttribute('aria-checked');
    const filled = ariaChecked === 'true';
    log(`Verification: aria-checked="${ariaChecked}" after click — ${filled ? 'selected' : 'NOT confirmed selected'}.`);

    return {
      targetFound: true,
      writeAttempted: true,
      valueAfterWrite: filled ? value : ariaChecked,
      filled,
      error: filled ? undefined : 'Click did not result in aria-checked="true" (widget behavior unverified in a live browser).',
    };
  }

  function fillDropdown(question, value, log) {
    log('Locating dropdown listbox and target option...');
    const { listbox, option, relocated } = locateDropdownParts(question, value);
    if (!listbox || !option) {
      log('RESULT: dropdown or target option NOT found.');
      return { targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Dropdown or its matching option could not be located on the page.' };
    }
    log(`Target found${relocated ? ' by re-querying' : ' via cached reference'}. Opening dropdown, then clicking option...`);
    listbox.click();
    option.click();

    const ariaSelected = option.getAttribute('aria-selected');
    const listboxText = (listbox.textContent || '').trim();
    const filled = ariaSelected === 'true' || listboxText.includes(value);
    log(`Verification: aria-selected="${ariaSelected}", listbox text="${listboxText}" — ${filled ? 'selected' : 'NOT confirmed selected'}.`);

    return {
      targetFound: true,
      writeAttempted: true,
      valueAfterWrite: filled ? value : listboxText,
      filled,
      error: filled ? undefined : 'Selection could not be verified after click (widget behavior unverified in a live browser).',
    };
  }

  function fillQuestion(question, match, log) {
    try {
      switch (question.type) {
        case 'short_text':
        case 'paragraph':
          return fillTextLike(question, match.proposedValue, log);
        case 'radio':
          return fillRadio(question, match.proposedValue, log);
        case 'dropdown':
          return fillDropdown(question, match.proposedValue, log);
        default:
          log(`Type "${question.type}" is not supported for autofill.`);
          return { targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: `Autofill not implemented for type "${question.type}".` };
      }
    } catch (err) {
      log('Unexpected error while filling:', err);
      return { targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: String(err) };
    }
  }

  function applyAutofill(questionIds) {
    const requested = Array.isArray(questionIds) ? questionIds : [];
    console.groupCollapsed(`[Job Autofill] Autofill requested for ${requested.length} question id(s)`);
    console.log('Requested question ids:', requested);

    const results = requested.map((id) => {
      const log = (...args) => console.log(`  [${id}]`, ...args);
      const question = lastQuestionsById.get(id);
      const match = lastMatchesById.get(id);
      const questionText = question ? question.normalizedText : (match ? match.questionText : '(unknown question)');

      log(`--- Processing "${questionText}" ---`);

      if (!question) {
        log('No cached question found for this id — was a scan run since the popup last opened?');
        return { questionId: id, questionText, targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Question not found in the last scan.' };
      }
      log(`Cached question found: type="${question.type}".`);

      if (!match || match.status !== 'matched') {
        log(`Match status is "${match ? match.status : 'missing'}", not "matched" — refusing to fill regardless of what was requested (safety re-check).`);
        return { questionId: id, questionText, targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Question is not in a safely matched state.' };
      }
      log(`Match confirmed: field="${match.matchedField}", confidence=${match.confidence}.`);

      if (!question.containerElement || !document.contains(question.containerElement)) {
        log('Question container element is no longer attached to the page.');
        return { questionId: id, questionText, targetFound: false, writeAttempted: false, valueAfterWrite: null, filled: false, error: 'Question is no longer present on the page.' };
      }
      log('Question container is present in the live DOM. Proceeding.');

      const outcome = fillQuestion(question, match, log);
      log(
        `RESULT: targetFound=${outcome.targetFound}, writeAttempted=${outcome.writeAttempted}, filled=${outcome.filled}` +
          (outcome.error ? `, error="${outcome.error}"` : '')
      );

      return {
        questionId: id,
        questionText,
        targetFound: Boolean(outcome.targetFound),
        writeAttempted: Boolean(outcome.writeAttempted),
        valueAfterWrite: outcome.valueAfterWrite !== undefined ? outcome.valueAfterWrite : null,
        filled: Boolean(outcome.filled),
        error: outcome.error || null,
      };
    });

    console.log('[Job Autofill] Autofill summary (values omitted from this table — see per-field logs above):');
    console.table(
      results.map((r) => ({
        questionText: r.questionText,
        targetFound: r.targetFound,
        writeAttempted: r.writeAttempted,
        filled: r.filled,
        error: r.error || '',
      }))
    );
    console.groupEnd();

    return results;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'JOBAUTOFILL_GET_STATUS') {
      sendResponse(getStatus());
      return true;
    }
    if (message && message.type === 'JOBAUTOFILL_SCAN_FORM') {
      scanForm().then(sendResponse);
      return true;
    }
    if (message && message.type === 'JOBAUTOFILL_APPLY_AUTOFILL') {
      const ids = Array.isArray(message.questionIds) ? message.questionIds : [];
      console.log(`[Job Autofill] Received JOBAUTOFILL_APPLY_AUTOFILL for ${ids.length} question id(s):`, ids);
      try {
        sendResponse({ ok: true, results: applyAutofill(ids) });
      } catch (err) {
        console.error('[Job Autofill] Autofill request failed unexpectedly:', err);
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }
    return false;
  });

  console.log('[Job Autofill] Content script loaded. Status:', getStatus());
})();
