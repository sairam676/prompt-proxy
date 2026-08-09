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
 * CURRENT DESIGN: Groq's only job is laying out the map — compressing the
 * user's full context into one clean, complete brief, AND judging mechanical
 * complexity (a fact-adjacent classification, not a diagnosis). The user's
 * actual chosen LLM does ALL the real reasoning: diagnosis, fix, and
 * self-critique. For non-trivial bugs, it's also asked to separate evidence
 * from assumption and self-report a confidence score grounded in that
 * separation — not because middleware computes the number, but because
 * middleware surfaces the facts (assumption count, citation grounding) that
 * the model uses to reason about its own certainty. Middleware counts;
 * the real LLM judges.
 */

const BRIEF_BUILDER_PROMPT = `
You compress a user's raw request and context into one clean, complete brief
for an expert LLM to act on. You are NOT solving anything yourself — you're
doing context layout and compression, not analysis.

This works for ANY task type: debugging, code review, interview prep, writing,
architecture, analysis, learning, etc. But debugging is the most common and
most critical use case — users constantly struggle with LLM-generated code that
broke something, hallucinated a dependency, or changed behavior they didn't
anticipate. For debugging tasks, preserving EXACT technical content is vital.

PRESERVATION RULES:
- Error messages, stack traces, code snippets, exact numbers → include VERBATIM.
  Do not summarize, paraphrase, or truncate code or errors.
- For non-code tasks: preserve the user's specific details, constraints, and
  context — don't generalize away specifics they gave.

If the user described multiple genuinely distinct, unrelated issues or tasks,
note that explicitly so the expert LLM knows to handle each independently.

COMPLEXITY CLASSIFICATION — how much reasoning the expert LLM will need:
- "simple": straightforward with no real ambiguity — a syntax error, a typo,
  a clear well-scoped question, a simple task with obvious scope.
- "medium": needs real reasoning but is well-defined — a logic bug with one
  likely cause, a task that requires thought but has clear boundaries.
- "complex": spans multiple components, has several plausible causes, is
  ambiguous or multi-part, or requires ruling out alternatives.

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
    model:    "llama-3.1-8b-instant",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BRIEF_BUILDER_PROMPT },
      { role: "user",   content: formatContext(userContext) },
    ],
  });

  let result;
try {
  result = JSON.parse(response.choices[0].message.content.trim());
  // JSON.parse succeeding doesn't guarantee the shape is right — Groq's
  // 8B model can return valid JSON that still deviates from the schema
  // (e.g. "brief" as a nested object instead of a plain string). If that
  // happens, a template literal downstream would silently stringify it
  // to "[object Object]" with no error. Catch that here instead.
  if (typeof result.brief !== "string" || !result.brief.trim()) {
    throw new Error("brief was not a usable string");
  }
} catch (_) {
  result = {
    brief: formatContext(userContext),
    distinct_issue_count: 1,
    complexity: "medium",
  };
}

  onStep({
    type:    "brief_done",
    message: "Context laid out",
    data:    { distinctIssueCount: result.distinct_issue_count, complexity: result.complexity },
  });

  return result;
};

/**
 * buildSimpleDiagnosticPrompt — for mechanically simple bugs (typos, missing
 * imports, syntax errors). Skips the evidence/assumption/confidence
 * scaffolding entirely — that structure is overhead for a one-line fix and
 * would dilute its value on the cases where it actually matters.
 */
export const buildSimpleDiagnosticPrompt = (brief) => `
You are debugging a real problem. Here is the full context:

${brief}

This looks like a simple, mechanical issue (syntax error, typo, missing
import, off-by-one, wrong variable name, malformed call, etc.). Skip formal
evidence/confidence analysis — just state the bug and the fix directly and
precisely, citing the specific line/property that's wrong.

If it turns out to be less straightforward than expected once you look
closely, say so honestly and ask ONE specific question — prefix this case
with "NEEDS_CLARIFICATION:" on its own line — instead of guessing.

Be precise and complete. No filler, no preamble, no sign-off.
`.trim();

/**
 * buildDiagnosticPrompt — the full evidence/assumption/confidence version,
 * for medium/complex bugs. Explicitly asks the real LLM to separate what it
 * directly observed in the given context from what it's inferring, and to
 * self-report a confidence score grounded in that separation — rather than
 * asserting a single hypothesis as fact (the exact failure mode a stronger
 * debugging engine needs to avoid: stating an unverified assumption, like
 * "a user updates their address", as if it were confirmed).
 */
export const buildDiagnosticPrompt = (brief, issueCount) => `
You are debugging a real problem. Here is the full context:

${brief}

Anything in the context marked "[CONFIRMED BY USER]" is a settled fact the
user directly confirmed — treat it as EVIDENCE, not an assumption, even if
it answers something you would otherwise have had to assume. Do not hedge
on a fact the user has already confirmed.

Do the following, in order:

1. EVIDENCE: List only what is directly observable in the given context —
facts you can point to in the actual code, logs, or timeline. Prefix each
with "✓". Do not include anything here that requires an inference.

2. HYPOTHESIS: State your root cause diagnosis${issueCount > 1 ? "es — there are multiple distinct issues here, diagnose each separately" : ""}.
Cite the SPECIFIC line/property/behavior in the given code that supports it.
If your diagnosis requires an event or condition that was NOT explicitly
stated in the given context (e.g. "assuming the user updates X"), you MUST
list it separately as an assumption, prefixed with "?" — never state an
unverified assumption as if it were confirmed fact.

3. CONFIDENCE: Give yourself a 0-100% confidence score for your primary
hypothesis. Base this strictly on how much of your hypothesis rests on
EVIDENCE above versus ASSUMPTIONS above — a hypothesis that depends on one or
more unverified assumptions should not be scored as if it were confirmed.
Reason about this honestly; don't default to a high number out of habit.

4. ALTERNATIVES: List at least one other plausible hypothesis with its own
rough confidence %, even if much lower — don't present only one theory as if
it were the only possibility, unless the evidence genuinely rules out
everything else.

5. IF YOUR CONFIDENCE IS LOW (below ~60%): rather than guessing, say so
explicitly and ask ONE specific, targeted question that would let you
distinguish between your top hypotheses. Prefix this case with
"NEEDS_CLARIFICATION:" on its own line, followed by your specific question.
Do not proceed to a fix on a low-confidence guess.

6. IF CONFIDENT: provide ONE complete, working fix per diagnosed issue — tied
explicitly to your top hypothesis, not a menu of alternative approaches.

7. SELF-CRITIQUE: ... Additionally, state explicitly what environment or
execution model your fix assumes to be correct (e.g. "this fix is correct
under JavaScript's single-threaded event loop; it would NOT be safe under
true multi-threading, shared memory, or a distributed system without
additional synchronization"). If your fix's correctness depends on an
assumption about the runtime environment, that assumption belongs in your
ASSUMPTIONS list from step 2, not left implicit.

Be precise and complete. No filler, no preamble, no sign-off.
`.trim();

/**
 * buildRepairPrompt — used when verifyFix rejects a fix (real syntax error
 * or fabricated package). Feeds the exact, specific failure back to the
 * SAME real LLM that produced it, and asks for a correction — not a second
 * model's opinion, just the original model given real error detail it
 * didn't have before.
 */
export const buildRepairPrompt = (previousResponse, issues) => `
Your previous response had a verified problem. Here is the exact issue found:

${issues.map(i => `- ${i.description}`).join("\n")}

Here was your previous response in full:
${previousResponse}

Provide a corrected version that fixes this specific problem. Keep the rest of
your diagnosis and reasoning if it was correct — only revise what's needed to
resolve the issue(s) listed above. Output in the same format as before
(diagnosis, fix, self-critique, etc.). Do not repeat the same mistake.
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