import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * extractAndAnalyze — Hypothesis Engine
 *
 * Instead of committing to one root_cause immediately, this generates
 * 2-4 competing hypotheses with confidence scores and evidence for/against.
 * The Sufficiency Gate decides whether we're allowed to proceed to diagnosis.
 */
const EXTRACTOR_PROMPT = `
You are a deep problem analyst. Given the user's full context, first determine how many
DISTINCT, INDEPENDENT issues are actually present — not different theories about one bug,
but genuinely separate problems (e.g. "checkout 500s" AND "unrelated memory leak in the
image resizer" would be 2 distinct issues; "checkout 500s, might be a race condition or
might be a cache problem" is 1 issue with 2 competing theories about its cause).

Most reports describe exactly ONE issue. Only split into multiple issues when the user's
context clearly describes genuinely unrelated symptoms/areas of the codebase. Do not
manufacture extra issues to seem thorough.

For EACH distinct issue, generate 2-4 competing hypotheses for what is causing THAT issue.
Hypotheses only compete with other hypotheses that share the same issue_id — a hypothesis
about issue_2 is never "competing" with a hypothesis about issue_1.

CRITICAL: The user has already provided their context. Do NOT say anything is missing.
Work with what you have. If the context is rich — use it fully.

For each hypothesis:
- issue_id: which distinct issue this theory belongs to (e.g. "issue_1", "issue_2")
- theory: specific, falsifiable theory of the cause
- confidence: 0-100, scored against ONLY the other hypotheses sharing its issue_id
- evidence_for: specific evidence from the user's context
- evidence_against: what's missing or what would rule this out

Scores should genuinely compete within each issue group — don't pad every hypothesis to
the same confidence. If evidence overwhelmingly points to one cause, score it 85+ and
give competitors under 40. If genuinely ambiguous, keep scores close.

Output ONLY this JSON:
{
  "issues": [
    { "issue_id": "issue_1", "summary": "one-line description of this distinct issue" }
  ],
  "hypotheses": [
    {
      "id": "h1",
      "issue_id": "issue_1",
      "theory": "specific, falsifiable theory of the cause",
      "confidence": 0,
      "evidence_for": "specific evidence from the user's context",
      "evidence_against": "what's missing or what would rule this out"
    }
  ],
  "problem_area": "exactly what area is affected",
  "severity": "low|medium|high",
  "complexity": "simple|medium|complex",
  "key_insight": "something important the user may not have realized",
  "what_to_verify": "how to confirm the solution worked",
  "potential_risks": "what could still go wrong"
}
`.trim();

export const extractAndAnalyze = async (userContext, onStep) => {
  onStep({ type: "status", message: "Generating competing hypotheses..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: EXTRACTOR_PROMPT },
      { role: "user",   content: formatContext(userContext) },
    ],
    response_format: { type: "json_object" },
  });

  const analysis = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "extraction_done",
    message: "Hypotheses generated",
    data: {
      hypotheses:  analysis.hypotheses,
      problemArea: analysis.problem_area,
      severity:    analysis.severity,
      complexity:  analysis.complexity,
      keyInsight:  analysis.key_insight,
    },
  });

  return analysis;
};

/**
 * buildSurgicalPrompt — only called AFTER the sufficiency gate passes.
 * Builds the one-shot prompt for the user's LLM using the winning hypothesis
 * as the confirmed diagnosis, not a guess.
 */
const SURGICAL_PROMPT_BUILDER = `
You write a single surgical prompt for an expert LLM. The root cause(s) have ALREADY
been diagnosed — you are not investigating, you are briefing an expert on exactly
what to fix.

You will be given an array of confirmed diagnoses — one per distinct issue. This could
be a single diagnosis (most common) or several, if the user's report described multiple
independent bugs.

CRITICAL:
- If there is ONE diagnosis: instruct the expert to provide ONE concrete, complete fix —
  not a list of alternative approaches. If multiple libraries/tools could work, tell them
  to pick the most standard/common one and implement THAT, fully.
- If there are MULTIPLE diagnoses (multiple distinct issues): instruct the expert to
  provide ONE fix PER issue — treat each as its own complete fix, clearly separated and
  labeled by which issue it addresses. Do NOT let the expert merge them into one solution,
  and do NOT let them present the issues as alternatives to each other — they are
  independent problems that each need solving.

The prompt must include ALL the user's actual content — their resume, code, JD,
error — everything verbatim. The expert LLM only sees this prompt. Make it complete.

Output ONLY this JSON:
{
  "surgical_prompt": "complete prompt for the expert LLM, includes all confirmed diagnoses (labeled by issue), all user context verbatim, and the fix-count instruction above"
}
`.trim();

export const buildSurgicalPrompt = async (diagnoses, userContext, onStep) => {
  onStep({ type: "status", message: "Building surgical prompt from confirmed diagnosis..." });

  // Accept either a single diagnosis object (legacy/common case) or an array
  const diagnosisList = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

  const response = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SURGICAL_PROMPT_BUILDER },
      {
        role:    "user",
        content: JSON.stringify({
          confirmed_diagnoses: diagnosisList,
          issue_count:         diagnosisList.length,
          user_context:        formatContext(userContext),
        }),
      },
    ],
    response_format: { type: "json_object" },
  });

  const { surgical_prompt } = JSON.parse(response.choices[0].message.content.trim());
  return surgical_prompt;
};

/**
 * rescoreHypotheses — Hypothesis Memory
 *
 * Called when the user answers a tie-break question. Instead of throwing
 * away prior hypotheses and re-running extractAndAnalyze from scratch, this
 * sends ONLY the two previously-competing hypotheses plus the new answer,
 * and asks for updated confidence/evidence for just those two. Everything
 * else in the hypothesis set is carried forward unchanged by the caller
 * (see sufficiencyGate.mergeHypotheses).
 */
const RESCORE_PROMPT = `
You previously proposed competing hypotheses for a problem. The user has now answered
a question specifically meant to break the tie between two of them. Re-score ONLY
those two hypotheses given this new evidence. Do not introduce new hypotheses.

If the new evidence clearly confirms one and rules out the other, the scores should
now be decisively far apart (e.g. 90+ vs under 20). If the answer is still ambiguous
between the two, keep them close but update evidence_for/evidence_against to reflect
what was learned.

Output ONLY this JSON:
{
  "hypotheses": [
    { "id": "same id as given", "confidence": 0, "evidence_for": "updated", "evidence_against": "updated" }
  ]
}
`.trim();

export const rescoreHypotheses = async (competingHypotheses, newAnswer, userContext, onStep) => {
  onStep({ type: "status", message: "Updating hypotheses with your answer..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.1-8b-instant", // narrow, cheap re-score — doesn't need the 70B model
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: RESCORE_PROMPT },
      {
        role:    "user",
        content: JSON.stringify({
          competing_hypotheses: competingHypotheses,
          user_answer:          newAnswer,
          full_context:         formatContext(userContext),
        }),
      },
    ],
  });

  const { hypotheses } = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "rescore_done",
    message: "Hypotheses updated",
    data:    { hypotheses },
  });

  return hypotheses;
};

const formatContext = (ctx) => {
  const parts = [];
  if (ctx.goal)             parts.push(`Goal: ${ctx.goal}`);
  if (ctx.existing_context) parts.push(`User's full context:\n${ctx.existing_context}`);
  if (ctx.already_tried)    parts.push(`Already tried: ${ctx.already_tried}`);
  if (ctx.expected_output)  parts.push(`Expected outcome: ${ctx.expected_output}`);
  if (ctx.constraints)      parts.push(`Constraints: ${ctx.constraints}`);
  if (ctx.domain)           parts.push(`Domain: ${ctx.domain}`);
  return parts.join("\n\n");
};