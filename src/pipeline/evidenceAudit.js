/**
 * evidenceAudit.js
 *
 * Middleware's job here is counting and checking facts, never judging
 * whether a diagnosis is correct. This does one thing: for each evidence
 * claim the real LLM cited (lines starting with "✓" in its response), check
 * whether the identifiers it mentions (variable/function/property names)
 * actually appear in the user's pasted code. This can't tell you if the
 * diagnosis is RIGHT — only whether the "evidence" it's standing on is
 * actually grounded in something the user gave us, or partly fabricated.
 *
 * This mirrors fixVerifier.js's philosophy: a deterministic lookup, not
 * a second model's opinion.
 */

// Pull out likely identifiers from a line of text: camelCase/snake_case
// words, dotted property access, function-call-looking tokens. Deliberately
// permissive — false positives (flagging something as "cited" that wasn't
// really a targeted claim) are cheap; false negatives (missing a real
// fabricated claim) are the thing worth avoiding.
const extractIdentifiers = (line) => {
  const matches = line.match(/\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\b/g) || [];
  // Filter out common English words that aren't likely to be code identifiers
  const STOPWORDS = new Set([
    "the","is","was","are","were","this","that","and","or","not","has","have",
    "been","being","with","from","when","which","that's","its","it","a","an",
    "on","in","of","to","for","as","at","by","if","then","else","also",
  ]);
  return matches
    .filter(m => m.length > 2 && !STOPWORDS.has(m.toLowerCase()))
    .map(m => m.split(".")[0]); // check base identifier, not full dotted path
};

const extractEvidenceLines = (llmResponse) => {
  return llmResponse
    .split("\n")
    .filter(line => /^\s*✓/.test(line))
    .map(line => line.replace(/^\s*✓\s*/, "").trim());
};

const extractAssumptionLines = (llmResponse) => {
  return llmResponse
    .split("\n")
    .filter(line => /^\s*\?/.test(line))
    .map(line => line.replace(/^\s*\?\s*/, "").trim());
};

/**
 * auditEvidence — checks each "✓" evidence line against the user's pasted
 * code/context. Returns which claims are grounded (identifiers found in the
 * source) vs ungrounded (couldn't verify any specific identifier mentioned).
 * Ungrounded doesn't necessarily mean false — a claim can be evidence-based
 * without naming a variable (e.g. "the error only occurs after 50+ chars").
 * This is a soft signal to surface, not a hard rejection.
 */
export const auditEvidence = (llmResponse, sourceCode) => {
  const evidenceLines    = extractEvidenceLines(llmResponse);
  const assumptionLines  = extractAssumptionLines(llmResponse);
  const source           = sourceCode || "";

  const auditedEvidence = evidenceLines.map(line => {
    const identifiers = extractIdentifiers(line);
    const namedIdentifiers = identifiers.filter(id => /^[a-z_$][a-zA-Z0-9_$]*$/.test(id));
    const checkable = namedIdentifiers.length > 0;
    const grounded = !checkable || namedIdentifiers.some(id => source.includes(id));

    return { claim: line, checkable, grounded };
  });

  const ungroundedCount = auditedEvidence.filter(e => e.checkable && !e.grounded).length;

  return {
    evidence:          auditedEvidence,
    assumptions:       assumptionLines,
    assumptionCount:   assumptionLines.length,
    ungroundedCount,
    hasUngroundedClaims: ungroundedCount > 0,
  };
};