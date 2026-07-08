/**
 * sufficiencyGate.js
 *
 * Decides whether the Hypothesis Engine's output is confident enough to
 * proceed to diagnosis, or whether we need to go back and ask the user
 * one more targeted question.
 *
 * Threshold: top hypothesis confidence > 80 AND runner-up confidence < 40.
 * This makes the gate deterministic instead of "the LLM felt sure."
 */

const TOP_THRESHOLD    = 80;
const RUNNER_UP_CEILING = 40;

export const isSufficient = (hypotheses = []) => {
  if (!hypotheses.length) {
    return {
      sufficient:      false,
      diagnosis:       null,
      tieBreakQuestion: "I don't have enough to form any hypothesis yet — can you share the error and relevant code?",
    };
  }

  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const [top, second] = sorted;

  const sufficient = top.confidence > TOP_THRESHOLD &&
                      (second?.confidence ?? 0) < RUNNER_UP_CEILING;

  if (sufficient) {
    return { sufficient: true, diagnosis: top, tieBreakQuestion: null };
  }

  // Not sufficient — build a targeted question that would break the tie
  // between the top two competing hypotheses.
  const tieBreakQuestion = second
    ? buildTieBreakQuestion(top, second)
    : `I'm not fully confident yet — ${top.evidence_against || "what would confirm or rule out: " + top.theory}?`;

  return { sufficient: false, diagnosis: null, tieBreakQuestion };
};

const buildTieBreakQuestion = (top, second) => {
  // Prefer asking about whatever would rule OUT the weaker/ambiguous side —
  // that's the fastest way to collapse to one hypothesis.
  const disambiguator = top.evidence_against || second.evidence_for;
  return `To narrow this down between "${top.theory}" and "${second.theory}": ${disambiguator}?`;
};

/**
 * updateHypotheses — used by hypothesis memory (session-scoped).
 * Applies a new answer as a lightweight re-score rather than discarding
 * prior hypotheses and starting over. The actual re-scoring call is Groq-based
 * (see extractAndAnalyze); this just merges the result back in by id.
 */
export const mergeHypotheses = (existing = [], updated = []) => {
  const byId = new Map(existing.map(h => [h.id, h]));
  for (const u of updated) {
    byId.set(u.id, { ...byId.get(u.id), ...u });
  }
  return [...byId.values()];
};