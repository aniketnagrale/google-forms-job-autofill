// Popup logic.
//
// On open, detects whether the active tab is a Google Form. "Scan Form"
// triggers extraction + matching in the content script and shows a summary
// here. "Review & Autofill" only opens a review list of what would be
// filled — it never fills anything by itself. Filling only happens after
// the user checks the fields they want and clicks "Confirm & Fill" inside
// that review panel, which sends exactly those question ids to the content
// script. Full structured detail (per-question reasoning) is logged to the
// Google Form page's own DevTools console, not this popup's.

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const scanBtn = document.getElementById('scanBtn');
  const autofillBtn = document.getElementById('autofillBtn');
  const profileBtn = document.getElementById('profileBtn');
  const summaryEl = document.getElementById('summary');
  const reviewPanel = document.getElementById('reviewPanel');
  const reviewList = document.getElementById('reviewList');
  const confirmFillBtn = document.getElementById('confirmFillBtn');
  const cancelFillBtn = document.getElementById('cancelFillBtn');
  const fillResultEl = document.getElementById('fillResult');

  let lastMatches = [];

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function queryActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      callback(tabs && tabs[0] ? tabs[0] : null);
    });
  }

  function sendToActiveTab(message, callback) {
    queryActiveTab((tab) => {
      if (!tab || !tab.id) {
        callback(null);
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          callback(null);
          return;
        }
        callback(response);
      });
    });
  }

  function checkStatus() {
    setStatus('Checking current page...');
    sendToActiveTab({ type: 'JOBAUTOFILL_GET_STATUS' }, (response) => {
      if (!response || !response.isGoogleForm) {
        setStatus('Not a Google Form page.');
        return;
      }
      setStatus(
        response.formTitle
          ? `Google Form detected: "${response.formTitle}"`
          : 'Google Form detected.'
      );
    });
  }

  function updateSummary(summary) {
    if (!summary) {
      summaryEl.hidden = true;
      return;
    }
    summaryEl.hidden = false;
    document.getElementById('sumTotal').textContent = summary.total;
    document.getElementById('sumMatched').textContent = summary.matched;
    document.getElementById('sumNeedsReview').textContent = summary.needsReview;
    document.getElementById('sumUnsupported').textContent = summary.unsupported;
    document.getElementById('sumUnmatched').textContent = summary.unmatched;
  }

  function scanForm() {
    setStatus('Scanning form...');
    autofillBtn.disabled = true;
    reviewPanel.hidden = true;
    lastMatches = [];

    sendToActiveTab({ type: 'JOBAUTOFILL_SCAN_FORM' }, (response) => {
      if (!response || !response.isGoogleForm) {
        setStatus('Not a Google Form page.');
        updateSummary(null);
        return;
      }

      lastMatches = response.matches || [];
      updateSummary(response.summary);

      const count = response.questions.length;
      if (count === 0) {
        setStatus('Google Form detected, but no questions were found.');
        return;
      }
      setStatus(`Found ${count} question(s). See the page console for full details.`);

      const hasSafeMatch = lastMatches.some((m) => m.status === 'matched');
      autofillBtn.disabled = !hasSafeMatch;
      autofillBtn.title = hasSafeMatch
        ? 'Review the matched fields before filling.'
        : 'No confidently matched fields to autofill yet.';
    });
  }

  function renderReview() {
    reviewList.innerHTML = '';
    fillResultEl.textContent = '';

    lastMatches.forEach((m) => {
      const li = document.createElement('li');
      li.className = `match-${m.status.replace(/_/g, '-')}`;

      if (m.status === 'matched') {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.questionId = m.questionId;
        const text = document.createElement('span');
        text.textContent = `${m.questionText} → "${m.proposedValue}"`;
        label.appendChild(checkbox);
        label.appendChild(text);
        li.appendChild(label);
      } else {
        const text = document.createElement('span');
        text.textContent = `${m.questionText} — ${m.reason}`;
        li.appendChild(text);
      }

      reviewList.appendChild(li);
    });

    reviewPanel.hidden = false;
  }

  // Writes a ✓/✗ marker under each checked review item using the per-field
  // result the content script returned, so success/failure is visible right
  // here without needing to open the page's DevTools console.
  function applyFillResultsToReview(results) {
    const byId = new Map(results.map((r) => [r.questionId, r]));
    reviewList.querySelectorAll('input[type="checkbox"][data-question-id]').forEach((checkbox) => {
      const result = byId.get(checkbox.dataset.questionId);
      if (!result) return;
      const li = checkbox.closest('li');
      let marker = li.querySelector('.fill-result');
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'fill-result';
        li.appendChild(marker);
      }
      if (result.filled) {
        marker.textContent = '✓ Filled and verified';
        marker.className = 'fill-result fill-ok';
      } else {
        marker.textContent =
          `✗ Not confirmed (targetFound=${result.targetFound}, writeAttempted=${result.writeAttempted})` +
          (result.error ? `: ${result.error}` : '');
        marker.className = 'fill-result fill-fail';
      }
    });
  }

  function confirmFill() {
    const checkedIds = Array.from(
      reviewList.querySelectorAll('input[type="checkbox"]:checked')
    ).map((cb) => cb.dataset.questionId);

    if (checkedIds.length === 0) {
      fillResultEl.textContent = 'No fields selected.';
      return;
    }

    console.log('[Job Autofill][popup] Sending Confirm & Fill for question ids:', checkedIds);
    fillResultEl.textContent = 'Filling...';
    sendToActiveTab({ type: 'JOBAUTOFILL_APPLY_AUTOFILL', questionIds: checkedIds }, (response) => {
      console.log('[Job Autofill][popup] Autofill response received:', response);
      if (!response || !response.ok) {
        fillResultEl.textContent = 'Autofill failed to run (no response from the page, or an error occurred). See the page console.';
        return;
      }
      applyFillResultsToReview(response.results);
      const successCount = response.results.filter((r) => r.filled).length;
      fillResultEl.textContent =
        `Filled ${successCount} of ${response.results.length} selected field(s) — see ✓/✗ marks above. ` +
        'Full per-field detail is in the page console.';
    });
  }

  scanBtn.addEventListener('click', scanForm);
  autofillBtn.addEventListener('click', renderReview);
  cancelFillBtn.addEventListener('click', () => {
    reviewPanel.hidden = true;
  });
  confirmFillBtn.addEventListener('click', confirmFill);
  profileBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  checkStatus();
});
