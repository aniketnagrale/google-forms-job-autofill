// Options page logic: load an existing profile into the form on open, save
// form values back to chrome.storage.local on submit, and show locally
// computed scan insights (see shared/storage.js for the scan-history and
// aggregation implementation — no data ever leaves the browser).

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('profileForm');
  const statusEl = document.getElementById('status');

  // Every field the profile form supports. Extending this list is the only
  // change needed here to add a new field — load/save logic is generic
  // over whatever ids are listed, and works the same for <input>, <select>,
  // and <textarea> since all three expose a plain `.value`.
  const fields = [
    'fullName',
    'email',
    'phone',
    'currentLocation',
    'hometown',
    'company',
    'jobTitle',
    'yearsExperience',
    'b2cExperience',
    'b2bExperience',
    'aiGenaiExperience',
    'linkedin',
    'portfolio',
    'noticePeriod',
    'availability',
    'currentCtc',
    'expectedCtc',
    'managedProductArea',
    'teamSize',
    'peopleManagementExperience',
    'highestEducation',
    'collegeInstitution',
    'willingToRelocate',
    'preferredWorkLocation',
    'workAuthorization',
  ];

  try {
    const profile = await JobAutofillStorage.getProfile();
    if (profile) {
      fields.forEach((field) => {
        const el = document.getElementById(field);
        // Existing saved profiles only have the original 8 keys; any field
        // added since then is simply absent, which this leaves untouched
        // (native default: empty text input / blank select / empty
        // textarea) rather than erroring.
        if (el && profile[field] !== undefined) {
          el.value = profile[field];
        }
      });
    }
  } catch (err) {
    console.error('[Job Autofill] Failed to load profile:', err);
    statusEl.textContent = 'Failed to load saved profile.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const profile = {};
    fields.forEach((field) => {
      const el = document.getElementById(field);
      profile[field] = el ? el.value.trim() : '';
    });

    try {
      await JobAutofillStorage.saveProfile(profile);
      statusEl.textContent = 'Profile saved.';
    } catch (err) {
      console.error('[Job Autofill] Failed to save profile:', err);
      statusEl.textContent = 'Failed to save profile.';
    }
  });

  // --- Scan insights ---------------------------------------------------

  const insightsStatusEl = document.getElementById('insightsStatus');
  const frequentQuestionsList = document.getElementById('frequentQuestionsList');
  const unmatchedQuestionsList = document.getElementById('unmatchedQuestionsList');
  const needsReviewQuestionsList = document.getElementById('needsReviewQuestionsList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  function renderPatternList(listEl, patterns, describe, emptyText) {
    listEl.innerHTML = '';
    if (!patterns || patterns.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
      return;
    }
    patterns.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = describe(p);
      listEl.appendChild(li);
    });
  }

  async function loadInsights() {
    try {
      const history = await JobAutofillStorage.getScanHistory();
      const insights = JobAutofillStorage.computeInsights(history);

      document.getElementById('insightsScans').textContent = insights.totalScans;
      document.getElementById('insightsQuestions').textContent = insights.totalQuestions;

      renderPatternList(
        frequentQuestionsList,
        insights.frequentQuestions,
        (p) =>
          `${p.displayText} — appeared in ${p.occurrenceCount} scan(s)` +
          (p.suggestedProfileField ? ` (matched: ${p.suggestedProfileField})` : ''),
        'No forms scanned yet.'
      );

      renderPatternList(
        unmatchedQuestionsList,
        insights.frequentlyUnmatched,
        (p) => `${p.displayText} — unmatched in ${p.unmatchedCount} scan(s)`,
        'None yet.'
      );

      renderPatternList(
        needsReviewQuestionsList,
        insights.frequentlyNeedsReview,
        (p) => `${p.displayText} — needed review in ${p.needsReviewCount} scan(s)`,
        'None yet.'
      );
    } catch (err) {
      console.error('[Job Autofill] Failed to load scan insights:', err);
      insightsStatusEl.textContent = 'Failed to load scan insights.';
    }
  }

  clearHistoryBtn.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Clear all locally stored scan history? This cannot be undone. Your saved profile is not affected.'
    );
    if (!confirmed) return;

    try {
      await JobAutofillStorage.clearScanHistory();
      await loadInsights();
      insightsStatusEl.textContent = 'Scan history cleared.';
    } catch (err) {
      console.error('[Job Autofill] Failed to clear scan history:', err);
      insightsStatusEl.textContent = 'Failed to clear scan history.';
    }
  });

  await loadInsights();
});
