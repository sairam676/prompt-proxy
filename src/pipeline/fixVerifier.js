import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * fixVerifier.js
 *
 * Runs on Groq before the fix is shown to the user. Checks the LLM's fix
 * for correctness issues that would otherwise waste the user's time.
 *
 * v1 (default): syntax, types, API/library correctness.
 * v2 (flagged): semantic preservation, concurrency/race conditions,
 *               adversarial counterexamples.
 *
 * Single file with feature flags per plan — v2 checks just flip on later,
 * no separate file/module to keep in sync.
 */

const CHECKS = {
  syntax:      true,
  types:       true,
  api:         true,
  semantics:   process.env.VERIFIER_V2 === "true",
  concurrency: process.env.VERIFIER_V2 === "true",
};

const buildVerifierPrompt = (checks) => `
You are a strict code verifier. Check the proposed fix ONLY for the categories
listed below — do not comment on style, do not suggest improvements outside scope.

Enabled checks:
${checks.syntax      ? "- Syntax correctness (does this actually parse/compile in its language)" : ""}
${checks.types        ? "- Type correctness (type mismatches, wrong signatures, incompatible args)" : ""}
${checks.api           ? "- API/library correctness (does the API used actually exist and behave as assumed — e.g. WeakMap requiring object keys, not strings)" : ""}
${checks.semantics    ? "- Semantic preservation (does the fix change behavior beyond what was intended)" : ""}
${checks.concurrency  ? "- Concurrency/race conditions (does the fix introduce or fail to address race conditions)" : ""}

For each issue found, be specific: quote the exact problematic construct and explain why it's wrong.
If you find zero issues in the enabled categories, say so explicitly — do not invent issues to seem thorough.

Output ONLY this JSON:
{
  "status": "verified|unverified|rejected",
  "issues": [
    { "category": "syntax|types|api|semantics|concurrency", "description": "specific issue found", "severity": "blocking|minor" }
  ],
  "notes": "brief explanation of the verdict"
}

status meanings:
- "verified": checked, no blocking issues found in enabled categories.
- "unverified": could not fully confirm correctness (e.g. insufficient context to check), but no confirmed issue either.
- "rejected": found at least one blocking issue.
`.trim();

export const verifyFix = async (llmResponse, userContext, onStep) => {
  onStep({ type: "status", message: "Verifying fix before showing it to you..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.1-8b-instant",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildVerifierPrompt(CHECKS) },
      {
        role:    "user",
        content: JSON.stringify({
          proposed_fix:   llmResponse,
          original_context: userContext.existing_context ?? userContext.raw_intent ?? "",
        }),
      },
    ],
  });

  const verification = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "verification_done",
    message: `Fix ${verification.status}`,
    data:    verification,
  });

  return verification;
};