import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * extractor.js
 *
 * OLD DESIGN: a cheap Groq model generated competing "hypotheses" about the
 * root cause, gated on confidence, and only then briefed the real LLM with
 * a "confirmed diagnosis." Testing showed this backwards: the cheap model
 * produced a confident, specific, WRONG diagnosis (see: tax bracket case),
 * and the real LLM inherited that error instead of reasoning through the
 * problem itself. A cheap model pretending to diagnose adds false certainty,
 * not correctness.
 *
 * NEW DESIGN: Groq's only job is laying out the map — compressing the
 * user's full context into one clean, complete brief. The user's actual
 * chosen LLM (Claude/OpenAI/whatever they connected) does ALL the real
 * reasoning: diagnosis, fix, self-critique, and — if it genuinely doesn't
 * have enough to go on — it says so and asks, rather than a weak model
 * guessing on its behalf. One call, real intelligence doing the actual work.
 */

const BRIEF_BUILDER_PROMPT = `
You compress a user's raw problem report into one clean, complete brief for an
expert LLM to solve. You are NOT diagnosing anything yourself — you're doing
context layout, not analysis. Preserve all technical content verbatim: error
messages, stack traces, code, exact numbers. Do not summarize or paraphrase
code or errors — include them exactly as given.

If the user described multiple genuinely distinct, unrelated issues, note that
explicitly so the expert LLM knows to solve each independently rather than
merging them.

Output ONLY this JSON:
{
  "brief": "the complete, clean brief for the expert LLM — includes all context verbatim",
  "distinct_issue_count": 1,
  "complexity": "simple|medium|complex"
}
`.trim();

export const buildBrief = async (userContext, onStep) => {
  onStep({ type: "status", message: "Laying out context..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.1-8b-instant", // pure compression/formatting, not judgment — 8B is fine here
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BRIEF_BUILDER_PROMPT },
      { role: "user",   content: formatContext(userContext) },
    ],
  });

  const result = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "brief_done",
    message: "Context laid out",
    data:    { distinctIssueCount: result.distinct_issue_count, complexity: result.complexity },
  });

  return result;
};

/**
 * buildDiagnosticPrompt — the ONE prompt sent to the user's real LLM.
 * Explicitly asks it to do the actual reasoning: diagnose with evidence,
 * propose a fix (one per distinct issue if multiple), self-critique its own
 * fix, and — critically — say so and ask a specific question if the evidence
 * genuinely doesn't support a confident diagnosis, instead of guessing.
 */
export const buildDiagnosticPrompt = (brief, issueCount) => `
You are debugging a real problem. Here is the full context:

${brief}

Do the following, in order:

1. DIAGNOSE: State your root cause diagnosis${issueCount > 1 ? "es — there are multiple distinct issues here, diagnose each separately" : ""}. 
Cite the SPECIFIC line/property/behavior in the given code that supports your diagnosis — 
if you can't point to something concrete in the code that demonstrates the cause, you 
don't have a confident diagnosis. Trace through the actual logic given; don't guess 
based on what's typical for this kind of bug.

2. IF YOU ARE NOT CONFIDENT: rather than guessing, say so explicitly and ask ONE 
specific, targeted question that would let you diagnose this correctly. Do not 
proceed to a fix on a guess — an honest "I need more information" is more useful 
than a confident wrong answer. Prefix this case with "NEEDS_CLARIFICATION:" on its 
own line, followed by your specific question.

3. IF CONFIDENT: provide ONE complete, working fix per diagnosed issue — not a menu 
of alternative approaches. If several tools/libraries could work, pick the standard 
one and implement it fully.

4. SELF-CRITIQUE: after writing the fix, re-read it critically. Does it actually 
compile/run? Does it address the diagnosis you gave, or does it just patch the 
symptom? Would it survive a case you haven't explicitly tested? State this 
critique explicitly — don't just assert the fix is correct.

Be precise and complete. No filler, no preamble, no sign-off.
`.trim();

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