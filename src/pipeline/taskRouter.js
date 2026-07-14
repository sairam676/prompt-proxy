/**
 * taskRouter.js
 *
 * Classifies whether an incoming message is a debugging task (needs the
 * full interview -> evidence/confidence -> verification -> repair pipeline)
 * or a general/conceptual question (just wants a direct answer from the
 * user's own LLM, no diagnostic machinery). This is a classification, not
 * a diagnosis — same category as buildBrief's complexity check, safe to
 * do cheaply and deterministically.
 *
 * A manual override (mode: "debug" | "general") always wins if the user
 * explicitly picks one via the UI toggle — this heuristic only applies
 * when no explicit mode was given.
 */

const DEBUG_SIGNALS = /\b(bug|error|crash|fix|debug|not working|failing|broken|exception|leak|slow|timeout|security|vulnerability|race|deadlock|performance|stack trace|undefined is not|cannot read propert)\b/i;

// Conceptual/learning questions rarely include pasted code AND rarely
// describe a broken system — they ask "what is" / "explain" / "how does
// X work" about a concept, not a specific failing implementation.
const CONCEPTUAL_SIGNALS = /\b(explain|what is|what are|how does .* work|difference between|concept of|teach me|understand)\b/i;

export const classifyTaskType = (message, explicitMode) => {
  if (explicitMode === "debug" || explicitMode === "general") {
    return explicitMode;
  }

  const hasCodeBlock = /```/.test(message) || /\bfunction\b.*\{|\bconst\b.*=.*\(/i.test(message);
  const hasDebugSignal = DEBUG_SIGNALS.test(message);
  const hasConceptualSignal = CONCEPTUAL_SIGNALS.test(message);

  // Debug signal present, or code pasted alongside a debug signal -> debug.
  if (hasDebugSignal) return "debug";

  // Conceptual phrasing with no debug signal and no pasted code -> general.
  if (hasConceptualSignal && !hasCodeBlock) return "general";

  // Ambiguous default: if code is pasted with no described problem, lean
  // debug (matches existing isDebuggingTask behavior in runner.js). If
  // there's no code and no clear signal either way, default general —
  // safer to under-trigger the heavyweight pipeline than over-trigger it
  // on a plain question.
  return hasCodeBlock ? "debug" : "general";
};