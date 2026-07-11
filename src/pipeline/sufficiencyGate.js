/**
 * sufficiencyGate.js
 *
 * Decides whether the Hypothesis Engine's output is confident enough to
 * proceed to diagnosis, or whether we need to go back and ask the user
 * one more targeted question.
 *
 * Threshold per issue: top hypothesis confidence > 80 AND runner-up confidence < 40.
 * This makes the gate deterministic, not vague.
 *
 * Hypotheses are grouped by issue_id — a report can describe multiple
 * distinct, independent bugs. Each issue's hypotheses only compete against
 * each other. The gate is sufficient only when EVERY issue group has a
 * clear winner; if one issue is still ambiguous, only that issue gets a
 * tie-break question — issues that already resolved don't get re-asked.
 */

const TOP_THRESHOLD    = 75;
const RUNNER_UP_CEILING = 45;

const groupByIssue = (hypotheses) => {
  const groups = new Map();
  for (const h of hypotheses) {
    const key = h.issue_id ?? "issue_1"; // fallback for legacy/ungrouped hypotheses
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  return groups;
};

const evaluateGroup = (hypotheses) => {
  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const [top, second] = sorted;
  if (!top) return { sufficient: false, diagnosis: null, competingIds: [] };
const hasEvidence = Boolean(top.evidence_for && top.evidence_for.trim().length > 0);

const sufficient = top.confidence > TOP_THRESHOLD &&
                    (second?.confidence ?? 0) < RUNNER_UP_CEILING &&
                    hasEvidence;

  if (sufficient) {
    return { sufficient: true, diagnosis: top, competingIds: [] };
  }

  const competingIds = [top.id, second?.id].filter(Boolean);
  const tieBreakQuestion = second
    ? buildTieBreakQuestion(top, second)
    : `I'm not fully confident yet — ${top.evidence_against || "what would confirm or rule out: " + top.theory}?`;

  return { sufficient: false, diagnosis: null, competingIds, tieBreakQuestion };
};

export const isSufficient = (hypotheses = []) => {
  if (!hypotheses.length) {
    return {
      sufficient:      false,
      diagnoses:       [],
      competingIds:    [],
      tieBreakQuestion: "I don't have enough to form any hypothesis yet — can you share the error and relevant code?",
    };
  }

  const groups = groupByIssue(hypotheses);
  const perIssue = [...groups.entries()].map(([issueId, hyps]) => ({
    issueId,
    ...evaluateGroup(hyps),
  }));

  const unresolved = perIssue.filter(g => !g.sufficient);

  if (unresolved.length === 0) {
    // Every distinct issue has a confident diagnosis
    return {
      sufficient:   true,
      diagnoses:    perIssue.map(g => g.diagnosis),
      competingIds: [],
      tieBreakQuestion: null,
    };
  }

  // At least one issue is still ambiguous — ask about the first unresolved
  // one specifically. Issues that already resolved are left alone; their
  // ids aren't in competingIds so a future re-score won't touch them.
  const target = unresolved[0];
  const question = perIssue.length > 1
    ? `Regarding "${target.issueId}": ${target.tieBreakQuestion}`
    : target.tieBreakQuestion;

  return {
    sufficient:   false,
    diagnoses:    [],
    competingIds: target.competingIds,
    tieBreakQuestion: question,
  };
};

/**
 * forceTopDiagnoses — used when the user explicitly gives up on answering
 * more tie-break questions ("that's all I have"). Skips the confidence
 * threshold entirely and just takes the current top hypothesis per issue
 * group, whatever it is. Each returned diagnosis is tagged forced: true
 * so the UI/prompt can be honest that this wasn't a confident match.
 */
export const forceTopDiagnoses = (hypotheses = []) => {
  const groups = groupByIssue(hypotheses);
  return [...groups.entries()].map(([issueId, hyps]) => {
    const top = [...hyps].sort((a, b) => b.confidence - a.confidence)[0];
    return { ...top, forced: true };
  }).filter(Boolean);
};

const buildTieBreakQuestion = (top, second) => {
  const disambiguator = second.evidence_against || top.evidence_against || second.evidence_for;
  return `To isolate whether this is "${top.theory}" or "${second.theory}", can you confirm: ${disambiguator}`;
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