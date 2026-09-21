// Shared storage utilities backed by chrome.storage.local.
// Loaded as a plain script (no bundler) so it can be included directly in
// content scripts and extension pages via a <script> tag or manifest
// content_scripts entry. Exposes a single global: JobAutofillStorage.

(function (global) {
  const STORAGE_KEY = 'jobAutofillProfile';
  const SCAN_HISTORY_KEY = 'jobAutofillScanHistory';
  // Bounded retention: a flat array of the most recent scans, capped at a
  // fixed length. Chosen over "aggregate stats + limited recent history"
  // because it's simpler to reason about and implement correctly — one
  // array, one trim step — and at this size is nowhere near
  // chrome.storage.local's default quota (each scan is a few small fields
  // per question; 100 scans of ~20 questions is well under a few hundred KB).
  const MAX_SCAN_HISTORY = 100;
  // Defensive cap on stored text fields. Question/form titles are the
  // form's own boilerplate labels, not user answers, but this bounds
  // storage growth and the unlikely case of a form embedding something
  // unexpectedly long in a label.
  const MAX_TEXT_LENGTH = 300;

  function getProfile() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(result[STORAGE_KEY] || null);
      });
    });
  }

  function saveProfile(profile) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: profile }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  function clearProfile() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(STORAGE_KEY, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  // --- Scan history -------------------------------------------------------
  // Stores only what's needed to learn which question patterns are common
  // and which profile fields they map to: question text (the form's own
  // label, not a user answer), type, required flag, matched field NAME
  // (e.g. "email" — never the email value itself), and match status.
  // Never stores proposedValue, profile values, or any answer content.

  function truncate(text) {
    const str = typeof text === 'string' ? text : '';
    return str.length > MAX_TEXT_LENGTH ? `${str.slice(0, MAX_TEXT_LENGTH)}…` : str;
  }

  function getScanHistory() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(SCAN_HISTORY_KEY, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(Array.isArray(result[SCAN_HISTORY_KEY]) ? result[SCAN_HISTORY_KEY] : []);
      });
    });
  }

  function setScanHistoryRaw(history) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SCAN_HISTORY_KEY]: history }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  function clearScanHistory() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(SCAN_HISTORY_KEY, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  function generateScanId() {
    return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function questionFingerprint(questions) {
    return (questions || []).map((q) => q.normalizedText || '').join('|');
  }

  function sanitizeQuestion(q) {
    return {
      questionId: q.questionId,
      originalText: truncate(q.originalText),
      normalizedText: truncate(q.normalizedText),
      type: q.type,
      required: Boolean(q.required),
      matchedField: q.matchedField || null,
      status: q.status,
    };
  }

  // Appends one scan record, unless it looks like an immediate re-scan of
  // the same form (same title, identical question set as the very last
  // stored record) — in that case the last record is refreshed in place
  // instead of appended, so repeatedly clicking "Scan Form" on an unchanged
  // page doesn't inflate the history or the aggregate counts. A form that
  // genuinely changes (different questions) or a different form entirely
  // still gets its own new entry. Applies retention after writing.
  async function addScanRecord({ formTitle, scannedAt, questionCount, questions }) {
    const sanitizedQuestions = (questions || []).map(sanitizeQuestion);
    const history = await getScanHistory();
    const last = history[history.length - 1];
    const sameSession =
      Boolean(last) &&
      (last.formTitle || null) === (formTitle || null) &&
      questionFingerprint(last.questions) === questionFingerprint(sanitizedQuestions);

    const record = {
      scanId: sameSession ? last.scanId : generateScanId(),
      formTitle: formTitle ? truncate(formTitle) : null,
      scannedAt,
      questionCount,
      questions: sanitizedQuestions,
    };

    const nextHistory = sameSession
      ? [...history.slice(0, -1), record]
      : [...history, record];
    const trimmed = nextHistory.slice(-MAX_SCAN_HISTORY);

    await setScanHistoryRaw(trimmed);
    return { history: trimmed, sameSession, record };
  }

  // --- Aggregate insights ---------------------------------------------------
  // Pure function over the stored history — deterministic normalization
  // only (lowercase + whitespace collapse + trailing marker strip), no
  // fuzzy clustering or LLM involvement. Case-folding groups "Current
  // Company" with "current company" without discarding the underlying
  // terms (CTC/B2C/AI/GenAI/LPA survive lowercasing, just not stripped).

  function normalizeForInsights(text) {
    return (text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*[*✱]\s*$/u, '')
      .trim();
  }

  function topDominantField(counts) {
    let best = null;
    let bestCount = 0;
    Object.entries(counts).forEach(([field, count]) => {
      if (count > bestCount) {
        best = field;
        bestCount = count;
      }
    });
    return best;
  }

  function computeInsights(history) {
    const list = Array.isArray(history) ? history : [];
    const totalScans = list.length;
    let totalQuestions = 0;

    const statusFrequency = { matched: 0, needs_review: 0, unsupported: 0, unmatched: 0 };
    const typeFrequency = {};
    const matchedFieldFrequency = {};
    let requiredFrequency = 0;
    const patternStats = new Map();

    list.forEach((scan) => {
      (scan.questions || []).forEach((q) => {
        totalQuestions += 1;
        if (Object.prototype.hasOwnProperty.call(statusFrequency, q.status)) {
          statusFrequency[q.status] += 1;
        }
        typeFrequency[q.type] = (typeFrequency[q.type] || 0) + 1;
        if (q.required) requiredFrequency += 1;
        if (q.matchedField) {
          matchedFieldFrequency[q.matchedField] = (matchedFieldFrequency[q.matchedField] || 0) + 1;
        }

        const key = normalizeForInsights(q.normalizedText || q.originalText || '');
        if (!key) return;
        if (!patternStats.has(key)) {
          patternStats.set(key, {
            normalizedQuestion: key,
            displayText: q.normalizedText || q.originalText || key,
            occurrenceCount: 0,
            requiredCount: 0,
            matchedCount: 0,
            needsReviewCount: 0,
            unsupportedCount: 0,
            unmatchedCount: 0,
            matchedFieldCounts: {},
          });
        }
        const stat = patternStats.get(key);
        stat.occurrenceCount += 1;
        if (q.required) stat.requiredCount += 1;
        if (q.status === 'matched') stat.matchedCount += 1;
        else if (q.status === 'needs_review') stat.needsReviewCount += 1;
        else if (q.status === 'unsupported') stat.unsupportedCount += 1;
        else if (q.status === 'unmatched') stat.unmatchedCount += 1;
        if (q.matchedField) {
          stat.matchedFieldCounts[q.matchedField] = (stat.matchedFieldCounts[q.matchedField] || 0) + 1;
        }
      });
    });

    const allPatterns = Array.from(patternStats.values()).map((s) => ({
      normalizedQuestion: s.normalizedQuestion,
      displayText: s.displayText,
      occurrenceCount: s.occurrenceCount,
      requiredCount: s.requiredCount,
      matchedCount: s.matchedCount,
      needsReviewCount: s.needsReviewCount,
      unsupportedCount: s.unsupportedCount,
      unmatchedCount: s.unmatchedCount,
      suggestedProfileField: topDominantField(s.matchedFieldCounts),
    }));

    const byCountDesc = (field) => (a, b) => b[field] - a[field];

    return {
      totalScans,
      totalQuestions,
      statusFrequency,
      typeFrequency,
      matchedFieldFrequency,
      requiredFrequency,
      frequentQuestions: [...allPatterns].sort(byCountDesc('occurrenceCount')).slice(0, 10),
      frequentlyUnmatched: allPatterns
        .filter((p) => p.unmatchedCount > 0)
        .sort(byCountDesc('unmatchedCount'))
        .slice(0, 10),
      frequentlyNeedsReview: allPatterns
        .filter((p) => p.needsReviewCount > 0)
        .sort(byCountDesc('needsReviewCount'))
        .slice(0, 10),
    };
  }

  global.JobAutofillStorage = {
    getProfile,
    saveProfile,
    clearProfile,
    STORAGE_KEY,
    getScanHistory,
    addScanRecord,
    clearScanHistory,
    computeInsights,
    MAX_SCAN_HISTORY,
  };
})(typeof window !== 'undefined' ? window : globalThis);
