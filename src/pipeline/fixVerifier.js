import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * fixVerifier.js
 *
 * Runs on Groq before the fix is shown to the user. Checks the LLM's fix
 * for correctness issues that would otherwise waste the user's time.
 *
 * v1 (default): syntax, types, API/library correctness (LLM judgment).
 * v2 (flagged): semantic preservation, concurrency/race conditions,
 *               adversarial counterexamples.
 *
 * DETERMINISTIC CHECK (always on, not LLM-based): package names imported in
 * code sections get checked against the real npm registry. A small model
 * guessing "does this package exist" just pattern-matches plausible-sounding
 * names — it can't actually know. An HTTP lookup can. This is exactly the
 * kind of check that shouldn't be delegated to another LLM's opinion.
 */

const CHECKS = {
  syntax:      true,
  types:       true,
  api:         true,
  semantics:   process.env.VERIFIER_V2 === "true",
  concurrency: process.env.VERIFIER_V2 === "true",
};

// ── Deterministic npm package existence check ──────────────────────────────
const extractNpmImports = (code) => {
  const names = new Set();

  // ES import: import x from 'pkg', import { x } from 'pkg/sub'
  for (const m of code.matchAll(/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
    names.add(m[1]);
  }
  // CommonJS: require('pkg')
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1]);
  }

  return [...names]
    .filter(n => !n.startsWith(".") && !n.startsWith("/")) // skip relative/local imports
    .map(n => {
      // Reduce to the installable package name: scoped pkgs keep @scope/name,
      // subpaths (e.g. "lodash/get") reduce to the package root ("lodash").
      const parts = n.split("/");
      return n.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    });
};

const checkPackagesExist = async (packageNames) => {
  const issues = [];
  await Promise.all(packageNames.map(async (pkg) => {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
        method: "GET",
      });
      if (res.status === 404) {
        issues.push({
          category:    "api",
          description: `Package "${pkg}" does not exist on the npm registry — this import will fail at install time.`,
          severity:    "blocking",
        });
      }
    } catch (_) {
      // Network failure during check — don't fail the fix over our own
      // check being unreachable, just skip it silently.
    }
  }));
  return issues;
};

const buildVerifierPrompt = (checks) => `
You are a strict code verifier. Check the proposed fix ONLY for the categories
listed below — do not comment on style, do not suggest improvements outside scope.
Do NOT comment on whether imported packages exist — that is checked separately
by an actual registry lookup, not by you guessing.

Enabled checks:
${checks.syntax      ? "- Syntax correctness (does this actually parse/compile in its language)" : ""}
${checks.types        ? "- Type correctness (type mismatches, wrong signatures, incompatible args)" : ""}
${checks.api           ? "- API correctness OF THE STANDARD LIBRARY / WELL-KNOWN APIS ONLY (e.g. WeakMap requiring object keys, not strings). Do not judge whether third-party packages exist." : ""}
${checks.semantics    ? "- Semantic preservation (does the fix change behavior beyond what was intended)" : ""}
${checks.concurrency  ? "- Concurrency/race conditions (does the fix introduce or fail to address race conditions)" : ""}

For each issue found, be specific: quote the exact problematic construct and explain why it's wrong.
If you find zero issues in the enabled categories, say so explicitly — do not invent issues to seem thorough.
Do not flag minor style preferences as issues — only flag things that are actually incorrect.

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

  const [llmVerification, packageNames] = await Promise.all([
    groq.chat.completions.create({
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
    }).then(r => JSON.parse(r.choices[0].message.content.trim())),
    Promise.resolve(extractNpmImports(llmResponse)),
  ]);

  onStep({ type: "status", message: `Checking ${packageNames.length} package name(s) against npm registry...` });
  const packageIssues = packageNames.length ? await checkPackagesExist(packageNames) : [];

  // Merge: deterministic package issues are never overridden by the LLM's
  // opinion. A fabricated package is always blocking, full stop.
  const allIssues = [...llmVerification.issues, ...packageIssues];
  const hasBlocking = allIssues.some(i => i.severity === "blocking");

  const verification = {
    status: hasBlocking ? "rejected" : llmVerification.status,
    issues: allIssues,
    notes:  llmVerification.notes,
  };

  onStep({
    type:    "verification_done",
    message: `Fix ${verification.status}`,
    data:    verification,
  });

  return verification;
};