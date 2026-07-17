/**
 * intentChecker.js
 *
 * Verification checks form (syntax, imports) but never intent — this was
 * the single most consistent gap found across the benchmark (see
 * BENCHMARK.md). This module closes a narrow, honest slice of that gap:
 * detecting DIRECTIONAL contradictions between what the user explicitly
 * asked for and what a config value in the generated fix actually does.
 *
 * This is deterministic keyword matching, not a diagnosis — same category
 * as fixVerifier.js's npm check. It does NOT attempt general intent
 * verification (that needs real execution against a stated test). It only
 * catches the specific, real pattern that broke the Redis fail-open case:
 * user says "fail open" / "allow through", fix sets a boolean the wrong way.
 */

// Pairs of (user-intent phrase) -> (expected boolean direction for common
// config keys associated with that intent). Intentionally narrow — this
// only fires when BOTH a directional phrase AND a matching config key
// appear, to avoid false positives on unrelated boolean values.
const DIRECTIONAL_INTENTS = [
  {
    intentPattern: /\bfail[\s-]?open\b|\ballow(?:ing)? requests? through\b|\bavailability matters more\b/i,
    directionLabel: "fail-open (allow through on failure)",
    configKeyPattern: /passOnStoreError/i,
    expectedValue: "true",
  },
  {
    intentPattern: /\bfail[\s-]?closed\b|\bblock requests?\b|\bdeny (?:on|when)\b|\bstrict enforcement\b/i,
    directionLabel: "fail-closed (block on failure)",
    configKeyPattern: /passOnStoreError/i,
    expectedValue: "false",
  },
  {
    intentPattern: /\ballow all\b|\bpermit all\b|\bopen access\b/i,
    directionLabel: "allow/permit",
    configKeyPattern: /\b(enabled|allowed|permit)\b/i,
    expectedValue: "true",
  },
  {
    intentPattern: /\bdeny all\b|\bblock all\b|\brestrict access\b/i,
    directionLabel: "deny/block",
    configKeyPattern: /\b(enabled|allowed|permit)\b/i,
    expectedValue: "false",
  },
];

/**
 * extractConfigAssignment — finds `key: value` or `key = value` pairs in
 * generated code matching a given key pattern, returns the literal value
 * found (as a string) or null if not present.
 */
const extractConfigAssignment = (code, keyPattern) => {
  const regex = new RegExp(`${keyPattern.source}\\s*[:=]\\s*(true|false|['"]?[\\w-]+['"]?)`, "i");
  const match = code.match(regex);
  return match ? match[1].replace(/['"]/g, "").toLowerCase() : null;
};

/**
 * checkIntentDirectionality — compares the user's stated original
 * requirement (goal + constraints + existing_context) against the
 * generated fix's actual config values. Returns an array of issues in the
 * same shape fixVerifier.js already uses, so they merge cleanly into the
 * existing verification result and can trigger the auto-repair loop.
 */
export const checkIntentDirectionality = (userContext, llmResponse) => {
  const statedText = [
    userContext.goal, userContext.constraints, userContext.existing_context, userContext.expected_output,
  ].filter(Boolean).join(" ");

  const issues = [];

  for (const rule of DIRECTIONAL_INTENTS) {
    if (!rule.intentPattern.test(statedText)) continue;

    const actualValue = extractConfigAssignment(llmResponse, rule.configKeyPattern);
    if (actualValue === null) continue; // config key not present in this fix, nothing to check

    if (actualValue !== rule.expectedValue) {
      issues.push({
        category:    "intent_mismatch",
        description: `You asked for ${rule.directionLabel}, but the fix sets a matching config value to "${actualValue}" instead of the expected "${rule.expectedValue}" — this looks like the opposite of what was requested.`,
        severity:    "blocking",
      });
    }
  }

  return issues;
};