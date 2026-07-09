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
      competingIds:    [],
      tieBreakQuestion: "I don't have enough to form any hypothesis yet — can you share the error and relevant code?",
    };
  }

  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const [top, second] = sorted;

  const sufficient = top.confidence > TOP_THRESHOLD &&
                      (second?.confidence ?? 0) < RUNNER_UP_CEILING;

  if (sufficient) {
    return { sufficient: true, diagnosis: top, competingIds: [], tieBreakQuestion: null };
  }

  // Not sufficient — the top two are the ones worth re-scoring next turn,
  // so hand their ids back to the caller (session gets to persist just these).
  const competingIds = [top.id, second?.id].filter(Boolean);

  const tieBreakQuestion = second
    ? buildTieBreakQuestion(top, second)
    : `I'm not fully confident yet — ${top.evidence_against || "what would confirm or rule out: " + top.theory}?`;

  return { sufficient: false, diagnosis: null, competingIds, tieBreakQuestion };
};

const buildTieBreakQuestion = (top, second) => {
  return `To isolate whether this is "${top.theory}" vs "${second.theory}", I need one specific data point: ${
    top.confidence > second.confidence
      ? second.evidence_against  // what would rule out the runner-up
      : top.evidence_against     // what would confirm the leader
  }. Can you check and confirm?`;
};

/**
 * mergeHypotheses — merges a re-scored subset of hypotheses back into the
 * full set by id. Used when resuming after a tie-break answer: only the
 * previously-competing pair gets re-scored, everything else is carried
 * forward unchanged.
 */
export const mergeHypotheses = (existing = [], updated = []) => {
  const byId = new Map(existing.map(h => [h.id, h]));
  for (const u of updated) {
    byId.set(u.id, { ...byId.get(u.id), ...u });
  }
  return [...byId.values()];
};