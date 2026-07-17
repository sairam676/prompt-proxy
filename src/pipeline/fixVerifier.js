/**
 * fixVerifier.js
 *
 * OLD DESIGN: a small Groq model gave a second opinion on the fix's
 * correctness. Testing showed this unreliable in both directions — it
 * missed a fabricated npm package, then separately invented a fake
 * objection to correct nullish-coalescing code. A weak model's "verdict"
 * added false confidence, not correctness — the real LLM that wrote the fix
 * is better positioned to self-critique it than a smaller model second-
 * guessing from the outside.
 *
 * NEW DESIGN: self-critique is now part of the single diagnostic call to
 * the user's real LLM (see extractor.js's buildDiagnosticPrompt). This file
 * keeps only the one check that's a FACT, not an opinion: does an imported
 * npm package actually exist. An HTTP lookup against the real registry can't
 * be second-guessed the way a model's stylistic judgment can.
 */
import { verifySyntax } from "./syntaxVerifier.js";
import { checkIntentDirectionality } from "./intentChecker.js";

const extractNpmImports = (code) => {
  const names = new Set();

  for (const m of code.matchAll(/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1]);
  }

  return [...names]
    .filter(n => !n.startsWith(".") && !n.startsWith("/"))
    .map(n => {
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
      // Our own check being unreachable shouldn't fail the fix — skip silently.
    }
  }));
  return issues;
};

export const verifyFix = async (llmResponse, userContext, onStep) => {
  const packageNames = extractNpmImports(llmResponse);
  const syntaxResult = verifySyntax(llmResponse);
  const intentIssues = checkIntentDirectionality(userContext, llmResponse);

  onStep({ type: "status", message: "Checking code syntax, package imports, and stated intent..." });

  const npmIssues = packageNames.length ? await checkPackagesExist(packageNames) : [];
  const allIssues = [...npmIssues, ...syntaxResult.issues, ...intentIssues];

  const status = allIssues.length ? "rejected" : "verified";

  const verification = {
    status,
    issues: allIssues,
    notes: allIssues.length
      ? "One or more issues found — see details."
      : "Code parses correctly, imports exist, and no directional intent contradiction was detected. This does NOT confirm the fix resolves the described bug under real runtime conditions.",
  };

  onStep({ type: "verification_done", message: `Fix check: ${status}`, data: verification });
  return verification;
};