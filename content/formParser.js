// Google Forms page detection and question extraction.
//
// Selector strategy: Google Forms is built to be accessible, so its
// respondent-facing markup consistently uses ARIA roles (listitem, heading,
// radiogroup, radio, checkbox, listbox) and aria-required/aria-label
// attributes. Those are used here as the primary signals instead of CSS
// class names, which Google changes/obfuscates across builds. Native
// input/textarea elements are used for short answer, paragraph, date, and
// file-upload questions since those are real form controls.
//
// This module has been validated against mock ARIA-structured DOM fixtures
// (see the project's test notes) but NOT against a live Google Form in this
// environment — no browser automation tool is available here. Treat
// confidence scores and the file-upload heuristic in particular as
// unverified until tested in a real browser.

(function (global) {
  function isGoogleFormPage() {
    return (
      window.location.hostname === 'docs.google.com' &&
      window.location.pathname.startsWith('/forms/')
    );
  }

  function getFormTitle() {
    const titleEl =
      document.querySelector('[role="heading"][aria-level="1"]') ||
      document.querySelector('.freebirdFormviewerViewHeaderTitle');
    return titleEl ? titleEl.textContent.trim() : null;
  }

  const QUESTION_TYPES = {
    SHORT_TEXT: 'short_text',
    PARAGRAPH: 'paragraph',
    RADIO: 'radio',
    CHECKBOX: 'checkbox',
    DROPDOWN: 'dropdown',
    DATE: 'date',
    FILE_UPLOAD: 'file_upload',
    UNKNOWN: 'unknown',
  };

  // ---------------------------------------------------------------------
  // Stable IDs: keyed by the actual container element, not by content, so
  // re-scanning the same live page (e.g. clicking "Scan Form" twice) always
  // returns the same id for the same question. IDs are only stable for the
  // lifetime of this page load, which matches "stable within the current
  // form" — a fresh page load is a new session.
  // ---------------------------------------------------------------------
  const questionIdMap = new WeakMap();
  let questionIdCounter = 0;

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function getStableId(container, normalizedText) {
    if (questionIdMap.has(container)) {
      return questionIdMap.get(container);
    }
    const id = `q_${hashString(normalizedText || 'untitled')}_${questionIdCounter++}`;
    questionIdMap.set(container, id);
    return id;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.offsetParent !== null || style.position === 'fixed';
  }

  // Returns top-level question containers: visible [role="listitem"]
  // elements that have a heading and at least one recognizable control,
  // and are not themselves nested inside another listitem (some option
  // rows may reuse role="listitem" internally). Filtering here is also
  // what keeps a single question from being extracted twice.
  function getQuestionContainers() {
    const all = Array.from(document.querySelectorAll('div[role="listitem"]'));
    return all.filter((item) => {
      if (!isVisible(item)) return false;
      if (!item.querySelector('[role="heading"]')) return false;
      if (
        !item.querySelector(
          '[role="radiogroup"], [role="checkbox"], [role="listbox"], [role="button"], input, textarea'
        )
      ) {
        return false;
      }
      const ancestorListitem = item.parentElement
        ? item.parentElement.closest('[role="listitem"]')
        : null;
      return !ancestorListitem;
    });
  }

  function hasAnyQuestionContainer() {
    return getQuestionContainers().length > 0;
  }

  function getRawHeadingText(item) {
    const heading = item.querySelector('[role="heading"]');
    if (!heading) return '';
    return heading.textContent.replace(/\s+/g, ' ').trim();
  }

  // Strips a single trailing required-marker asterisk (with optional
  // surrounding whitespace). Only the trailing marker is touched, so
  // meaningful terms and symbols elsewhere in the text (CTC, LPA, B2C, AI,
  // GenAI, ₹, etc.) are left untouched.
  function normalizeQuestionText(rawText) {
    return rawText
      .replace(/\s+/g, ' ')
      .replace(/\s*[*✱]\s*$/u, '')
      .trim();
  }

  // Required detection is attribute-based only (never a text/asterisk
  // scan), so a stray "*" appearing inside a question's own text can never
  // cause a false positive here.
  function extractIsRequired(item) {
    if (item.querySelector('[aria-label="Required question"]')) return true;
    return Boolean(item.querySelector('[aria-required="true"]'));
  }

  function labelFor(el) {
    return (
      el.getAttribute('data-answer-value') ||
      el.getAttribute('data-value') ||
      el.getAttribute('aria-label') ||
      el.textContent ||
      ''
    ).trim();
  }

  // Finds a free-text "Other" input that belongs to a choice question but
  // sits outside the given options container.
  function findOtherInput(item, optionsContainer) {
    const textInput = Array.from(item.querySelectorAll('input[type="text"]')).find(
      (el) => !optionsContainer.contains(el)
    );
    return textInput || null;
  }

  function extractDate(item) {
    const candidates = Array.from(
      item.querySelectorAll('input[type="text"], input[type="date"], input[type="number"]')
    );
    const dateInputs = candidates.filter((el) => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      return /day|month|year|date|hour|minute|time/.test(label);
    });
    if (dateInputs.length === 0) return null;

    const strongMatches = dateInputs.filter((el) =>
      /day|month|year/.test((el.getAttribute('aria-label') || '').toLowerCase())
    ).length;

    return {
      type: QUESTION_TYPES.DATE,
      options: [],
      inputElements: dateInputs,
      confidence: strongMatches >= 2 ? 0.85 : 0.5,
    };
  }

  function extractMultipleChoice(item) {
    const group = item.querySelector('[role="radiogroup"]');
    if (!group) return null;
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    if (radios.length === 0) return null;
    const options = radios.map((el) => ({ label: labelFor(el), element: el }));
    const hasLabels = options.some((o) => o.label);
    return {
      type: QUESTION_TYPES.RADIO,
      options,
      inputElements: radios,
      // "Other" choices sometimes have a free-text input outside the
      // radiogroup for the custom response; captured for later phases.
      otherInputElement: findOtherInput(item, group),
      confidence: hasLabels ? 0.9 : 0.4,
    };
  }

  function extractCheckboxes(item) {
    const boxes = Array.from(item.querySelectorAll('[role="checkbox"]'));
    if (boxes.length === 0) return null;
    const options = boxes.map((el) => ({ label: labelFor(el), element: el }));
    const hasLabels = options.some((o) => o.label);
    // Checkbox groups may live inside a wrapping [role="list"]; fall back to
    // the item itself as the "container" for other-input detection when no
    // dedicated group wrapper is found.
    const group = item.querySelector('[role="list"]') || item;
    return {
      type: QUESTION_TYPES.CHECKBOX,
      options,
      inputElements: boxes,
      otherInputElement: findOtherInput(item, group),
      confidence: hasLabels ? 0.9 : 0.4,
    };
  }

  function extractDropdown(item) {
    const listbox = item.querySelector('[role="listbox"]');
    if (!listbox) return null;

    let options = [];
    const owns = listbox.getAttribute('aria-owns');
    if (owns) {
      options = owns
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((el) => ({ label: labelFor(el), element: el }));
    }
    if (options.length === 0) {
      // Some dropdown menus only populate their option list in the DOM once
      // opened by the user (a portal-rendered menu). A static, non-clicking
      // pass can't see those without simulating interaction, which is out
      // of scope for extraction. Reported as optionsComplete: false rather
      // than guessing values — this is the safest practical approach for
      // this phase.
      options = Array.from(item.querySelectorAll('[role="option"]')).map((el) => ({
        label: labelFor(el),
        element: el,
      }));
    }

    const optionsComplete = options.length > 0;
    return {
      type: QUESTION_TYPES.DROPDOWN,
      options,
      inputElements: [listbox],
      optionsComplete,
      confidence: optionsComplete ? 0.85 : 0.5,
    };
  }

  // File-upload questions use a custom "Add file" control rather than a
  // plain visible <input type="file"> in most cases; the input, if present,
  // may also be hidden until the control is activated. This is the least
  // verified detector in this module — confirm against a live form.
  function extractFileUpload(item) {
    const fileInput = item.querySelector('input[type="file"]');
    if (fileInput) {
      return {
        type: QUESTION_TYPES.FILE_UPLOAD,
        options: [],
        inputElements: [fileInput],
        confidence: 0.9,
      };
    }
    const button = Array.from(item.querySelectorAll('[role="button"]')).find((el) =>
      /add file|upload|browse/i.test((el.getAttribute('aria-label') || el.textContent || '').trim())
    );
    if (button) {
      return {
        type: QUESTION_TYPES.FILE_UPLOAD,
        options: [],
        inputElements: [button],
        confidence: 0.6,
      };
    }
    return null;
  }

  function extractShortAnswerOrParagraph(item) {
    const textarea = item.querySelector('textarea');
    if (textarea) {
      return {
        type: QUESTION_TYPES.PARAGRAPH,
        options: [],
        inputElements: [textarea],
        confidence: 0.85,
      };
    }
    const textInput = item.querySelector('input[type="text"]');
    if (textInput) {
      return {
        type: QUESTION_TYPES.SHORT_TEXT,
        options: [],
        inputElements: [textInput],
        confidence: 0.65,
      };
    }
    return null;
  }

  // Order matters:
  //  - Date fields are plain text inputs distinguished only by aria-label,
  //    so they're checked before the generic short-answer/paragraph
  //    fallback.
  //  - Choice-based types are checked before the fallback too, since an
  //    "Other" free-text input inside a choice question would otherwise be
  //    misclassified as its own short-answer question.
  //  - File upload is checked before the generic text fallback since a
  //    file-upload widget has no text/textarea input to match anyway, but
  //    ordering it here keeps the chain's intent explicit.
  function extractControl(item) {
    return (
      extractDate(item) ||
      extractMultipleChoice(item) ||
      extractCheckboxes(item) ||
      extractDropdown(item) ||
      extractFileUpload(item) ||
      extractShortAnswerOrParagraph(item)
    );
  }

  function computeStatus(type, confidence, optionsComplete) {
    if (type === QUESTION_TYPES.UNKNOWN) return 'needs_review';
    if (type === QUESTION_TYPES.FILE_UPLOAD) return 'needs_review';
    // A choice question whose options couldn't be resolved (e.g. a dropdown
    // menu that only renders once opened) always needs a human look,
    // independent of the numeric confidence score.
    if (optionsComplete === false) return 'needs_review';
    if (confidence < 0.5) return 'needs_review';
    return 'detected';
  }

  function extractQuestions() {
    const items = getQuestionContainers();
    const questions = [];

    items.forEach((item, index) => {
      try {
        const control = extractControl(item);
        const originalText = getRawHeadingText(item);
        const normalizedText = normalizeQuestionText(originalText);
        const type = control ? control.type : QUESTION_TYPES.UNKNOWN;
        const confidence = control ? control.confidence : 0;
        const optionsComplete = control && 'optionsComplete' in control ? control.optionsComplete : true;

        questions.push({
          id: getStableId(item, normalizedText),
          originalText,
          normalizedText,
          type,
          required: extractIsRequired(item),
          options: control ? control.options.map((o) => o.label).filter(Boolean) : [],
          status: computeStatus(type, confidence, optionsComplete),
          confidence,
          domIndex: index,
          // Internal-only fields: live DOM references for later phases and
          // the optionsComplete flag. These must never be sent through
          // chrome.runtime messaging as-is (DOM nodes aren't serializable);
          // the content script strips them before responding to the popup.
          inputElements: control ? control.inputElements : [],
          optionElements: control ? control.options : [],
          otherInputElement: control ? control.otherInputElement || null : null,
          optionsComplete,
          containerElement: item,
        });
      } catch (err) {
        console.error('[Job Autofill] Failed to parse question at index', index, err);
        const originalText = '(failed to parse)';
        questions.push({
          id: getStableId(item, originalText),
          originalText,
          normalizedText: originalText,
          type: QUESTION_TYPES.UNKNOWN,
          required: false,
          options: [],
          status: 'needs_review',
          confidence: 0,
          domIndex: index,
          inputElements: [],
          optionElements: [],
          otherInputElement: null,
          optionsComplete: false,
          containerElement: item,
          error: String(err),
        });
      }
    });

    return questions;
  }

  global.JobAutofillFormParser = {
    isGoogleFormPage,
    getFormTitle,
    QUESTION_TYPES,
    hasAnyQuestionContainer,
    extractQuestions,
  };
})(window);
