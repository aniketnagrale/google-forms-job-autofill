// Deterministic field matching between extracted Google Forms questions and
// the user's saved profile.
//
// Deliberately pure: takes question data + a profile object, returns match
// data. No DOM access at all, which is what lets this module be unit-tested
// directly in plain Node (no jsdom needed) and keeps matching logic fully
// separate from the DOM-manipulation code in content.js, which owns the
// live element references needed to actually fill the form.

(function (global) {
  const PROFILE_FIELDS = [
    'fullName',
    'email',
    'phone',
    'company',
    'jobTitle',
    'yearsExperience',
    'linkedin',
    'portfolio',
    // Added in Phase 4:
    'currentLocation',
    'hometown',
    'b2cExperience',
    'b2bExperience',
    'aiGenaiExperience',
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

  // Question types content.js actually knows how to fill in this phase.
  // Declared here (not just in content.js) so a question of an unsupported
  // type is never reported as "matched" even if its text happens to
  // resemble a profile field keyword.
  const AUTOFILL_SUPPORTED_TYPES = new Set(['short_text', 'paragraph', 'radio', 'dropdown']);

  // Ordered by specificity (most specific first) — the first rule whose
  // test passes wins. Deterministic and easy to extend, versus a fuzzy
  // multi-rule scoring system.
  const RULES = [
    { field: 'linkedin', confidence: 0.95, test: (t) => /\blinkedin\b/i.test(t) },
    { field: 'portfolio', confidence: 0.95, test: (t) => /\bportfolio\b/i.test(t) },
    { field: 'email', confidence: 0.95, test: (t) => /\bemail\b/i.test(t) },
    { field: 'phone', confidence: 0.9, test: (t) => /\b(mobile|phone|cell|contact number)\b/i.test(t) },

    // --- Compensation: "current"/"present" and "expected" are mutually
    // exclusive guards on both rules, so a single confusingly-worded
    // question naming both (e.g. "Current vs Expected CTC") matches
    // neither rather than being force-assigned to one. A bare "Salary"
    // question with no further qualifier matches nothing here either —
    // deliberately, per "don't match generic salary questions".
    {
      field: 'currentCtc',
      confidence: 0.9,
      test: (t) => /\b(current|present)\s+ctc\b/i.test(t) && !/expected/i.test(t),
    },
    {
      field: 'expectedCtc',
      confidence: 0.9,
      test: (t) =>
        (/\bexpected\s+ctc\b/i.test(t) || /\bsalary\s+expectation\b/i.test(t)) &&
        !/\b(current|present)\b/i.test(t),
    },

    { field: 'noticePeriod', confidence: 0.9, test: (t) => /\bnotice\s+period\b/i.test(t) },
    {
      field: 'availability',
      confidence: 0.85,
      test: (t) =>
        /\bwhen\s+can\s+you\s+join\b/i.test(t) ||
        /\bjoining\s+date\b/i.test(t) ||
        /\bavailability\s+to\s+join\b/i.test(t),
    },

    // --- Location: disjoint keyword sets by construction (no shared words
    // between "current location" and "hometown" phrasing), so neither rule
    // can accidentally fire on the other's question.
    {
      field: 'currentLocation',
      confidence: 0.85,
      test: (t) =>
        /\bcurrent\s+location\b/i.test(t) ||
        /where\s+are\s+you\s+(currently\s+)?located/i.test(t) ||
        /\b(current\s+city|currently\s+based|city\s+of\s+residence)\b/i.test(t),
    },
    { field: 'hometown', confidence: 0.9, test: (t) => /\bhome\s*town\b/i.test(t) },
    {
      field: 'preferredWorkLocation',
      confidence: 0.85,
      test: (t) => /\bpreferred\s+(work\s+)?location\b/i.test(t),
    },
    {
      field: 'willingToRelocate',
      confidence: 0.85,
      test: (t) => /\bwilling\s+to\s+relocate\b/i.test(t) || /\brelocat(e|ion)\b/i.test(t),
    },

    {
      field: 'company',
      confidence: 0.9,
      test: (t) => /\bcurrent\s+(company|employer)\b/i.test(t),
    },
    {
      field: 'jobTitle',
      confidence: 0.9,
      test: (t) => /\bcurrent\s+(designation|job\s*title|title|role|position)\b/i.test(t),
    },

    // --- Experience breakdowns: checked before the generic total-experience
    // rule below (which also independently excludes these keywords —
    // belt-and-suspenders against the two rule sets ever double-firing).
    {
      field: 'b2cExperience',
      confidence: 0.85,
      test: (t) => /\bb2c\b/i.test(t) && /\bexperience\b/i.test(t),
    },
    {
      field: 'b2bExperience',
      confidence: 0.85,
      test: (t) => /\bb2b\b/i.test(t) && /\bexperience\b/i.test(t),
    },
    {
      field: 'aiGenaiExperience',
      confidence: 0.7,
      test: (t) => /\b(ai|genai)\b/i.test(t) && /\b(experience|product|feature|worked)\b/i.test(t),
    },
    {
      field: 'peopleManagementExperience',
      confidence: 0.8,
      test: (t) =>
        /\bpeople\s+management\b/i.test(t) ||
        /\bmanaging\s+(a\s+)?team\b/i.test(t) ||
        /\bdirect\s+reports\b/i.test(t),
    },
    {
      // Must be a TOTAL/overall experience question, never a narrower
      // sub-experience breakdown ("...experience specifically in B2C
      // consumer products") and never a compensation (CTC/LPA) question —
      // those aren't the same fact as total years of experience.
      field: 'yearsExperience',
      confidence: 0.85,
      test: (t) =>
        /\bexperience\b/i.test(t) &&
        /\btotal\b/i.test(t) &&
        !/specifically|\bb2c\b|\bb2b\b|\bai\b|\bgenai\b|\bctc\b|\blpa\b/i.test(t),
    },

    // --- Career details. managedProductArea deliberately requires the word
    // "managed" to co-occur with "product"+"area/domain" — a bare "product
    // area" (e.g. "...owned a B2C consumer-facing product or product
    // area?") must NOT match this, since that question is really about
    // ownership, not what the candidate has managed.
    {
      field: 'managedProductArea',
      confidence: 0.75,
      test: (t) => /\bmanaged\b/i.test(t) && /\bproduct\b/i.test(t) && /\b(area|domain)\b/i.test(t),
    },
    { field: 'teamSize', confidence: 0.85, test: (t) => /\bteam\s+size\b/i.test(t) },
    {
      field: 'highestEducation',
      confidence: 0.85,
      test: (t) => /\bhighest\s+(education|qualification|degree)\b/i.test(t),
    },
    {
      field: 'collegeInstitution',
      confidence: 0.8,
      test: (t) => /\b(college|university|alma\s+mater)\b/i.test(t),
    },
    {
      field: 'workAuthorization',
      confidence: 0.75,
      test: (t) =>
        /\bwork\s+authoriz(e|ation)\b/i.test(t) ||
        /\bvisa\s+status\b/i.test(t) ||
        /\bauthorized\s+to\s+work\b/i.test(t) ||
        /\brequire\s+sponsorship\b/i.test(t),
    },

    // Generic "name" is checked last: it's the least distinctive keyword
    // here, so every more specific rule gets first refusal.
    { field: 'fullName', confidence: 0.75, test: (t) => /\bname\b/i.test(t) },
  ];

  function normalizeForCompare(text) {
    return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Finds an option whose label exactly matches the proposed value
  // (case-insensitive, whitespace-normalized). Returns the option's own
  // label — never the raw profile value — so the caller fills in exactly
  // what will visibly be selected. Returns null on anything less than an
  // exact match; callers must never fall back to a partial/fuzzy match for
  // radio or dropdown questions.
  function findExactOptionMatch(options, proposedValue) {
    if (!proposedValue || !Array.isArray(options)) return null;
    const target = normalizeForCompare(proposedValue);
    if (!target) return null;
    return options.find((label) => normalizeForCompare(label) === target) || null;
  }

  function baseResult(question) {
    return {
      questionId: question.id,
      questionText: question.normalizedText,
      matchedField: null,
      proposedValue: null,
      confidence: 0,
    };
  }

  function matchQuestion(question, profile) {
    const base = baseResult(question);

    if (question.type === 'file_upload') {
      return {
        ...base,
        status: 'needs_review',
        reason: 'File upload requires manual selection; automatic resume upload is not implemented.',
      };
    }

    if (!AUTOFILL_SUPPORTED_TYPES.has(question.type)) {
      return {
        ...base,
        status: 'unsupported',
        reason: `Autofill is not implemented for question type "${question.type}" in this phase.`,
      };
    }

    const rule = RULES.find((r) => r.test(question.normalizedText));
    if (!rule) {
      return {
        ...base,
        status: 'unmatched',
        reason: 'No matching profile field found for this question.',
      };
    }

    const rawValue = profile ? profile[rule.field] : undefined;
    const hasValue = typeof rawValue === 'string' && rawValue.trim().length > 0;

    if (!hasValue) {
      return {
        ...base,
        matchedField: rule.field,
        confidence: rule.confidence,
        status: 'needs_review',
        reason: `Recognized as "${rule.field}" but no value is saved in your profile.`,
      };
    }

    if (question.type === 'radio' || question.type === 'dropdown') {
      const exactOption = findExactOptionMatch(question.options, rawValue);
      if (!exactOption) {
        return {
          ...base,
          matchedField: rule.field,
          confidence: rule.confidence,
          status: 'needs_review',
          reason: `Recognized as "${rule.field}" but no exact option match was found among the choices.`,
        };
      }
      return {
        ...base,
        matchedField: rule.field,
        proposedValue: exactOption,
        confidence: rule.confidence,
        status: 'matched',
        reason: `Matched "${rule.field}" keyword with an exact option match.`,
      };
    }

    return {
      ...base,
      matchedField: rule.field,
      proposedValue: rawValue.trim(),
      confidence: rule.confidence,
      status: 'matched',
      reason: `Matched "${rule.field}" keyword.`,
    };
  }

  function matchQuestions(questions, profile) {
    return (questions || []).map((q) => {
      try {
        return matchQuestion(q, profile || {});
      } catch (err) {
        return {
          ...baseResult(q),
          status: 'unsupported',
          reason: `Matching failed: ${String(err)}`,
        };
      }
    });
  }

  global.JobAutofillFieldMatcher = {
    PROFILE_FIELDS,
    AUTOFILL_SUPPORTED_TYPES,
    findExactOptionMatch,
    matchQuestions,
  };
})(typeof window !== 'undefined' ? window : globalThis);
