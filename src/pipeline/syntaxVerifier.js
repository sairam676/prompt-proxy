/**
 * syntaxVerifier.js
 *
 * Deterministic syntax check — does the fixed code actually parse as valid
 * JavaScript/JSX. This is a fact (parses / doesn't parse), not an opinion,
 * same category as fixVerifier.js's npm check.
 *
 * IMPORTANT SCOPE DECISION: this only checks EXPLICITLY FENCED (```) code
 * blocks. An earlier version tried to guess whether raw, unfenced text was
 * code (via keyword heuristics) so it could short-circuit before calling
 * the LLM at all — that guess kept being wrong (an apostrophe in "What's",
 * the bare word "function" used as an English noun, prose mixed with
 * code), each time causing a real user message to be misread as broken
 * JavaScript. Rather than continue patching the heuristic, the raw-text
 * fallback is removed entirely. Fenced blocks are an unambiguous signal
 * the user intentionally marked as code — zero false-positive risk there.
 * For anything unfenced, the real LLM sees it and judges for itself
 * whether there's a syntax issue, as part of its normal diagnosis — the
 * middleware doesn't try to preempt that judgment on a guess.
 */
import { Parser } from "acorn";
import jsx from "acorn-jsx";

const JSXParser = Parser.extend(jsx());

const extractCodeBlocks = (llmResponse) => {
  const blocks = [];
  const regex = /```(?:javascript|js|jsx)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(llmResponse)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
};

export const verifySyntax = (llmResponse) => {
  const blocks = extractCodeBlocks(llmResponse);

  if (!blocks.length) {
    // No fenced code blocks — nothing to deterministically check. Do NOT
    // guess at raw text; let it flow through to the LLM, which can judge
    // for itself whether there's actual code and whether it's broken.
    return { checked: false, issues: [] };
  }

  const issues = [];
  blocks.forEach((code, i) => {
    try {
      JSXParser.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
      });
    } catch (err) {
      issues.push({
        blockIndex: i,
        category:    "syntax",
        description: `Code block ${i + 1} has a syntax error: ${err.message}`,
        severity:    "blocking",
      });
    }
  });

  return { checked: true, issues };
};