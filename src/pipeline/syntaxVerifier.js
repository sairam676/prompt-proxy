/**
 * syntaxVerifier.js
 *
 * Deterministic syntax check — does the fixed code actually parse as valid
 * JavaScript. This is a fact (parses / doesn't parse), not an opinion, same
 * category as fixVerifier.js's npm check. Doesn't run the code, doesn't
 * check logic — just catches "this wouldn't even load."
 */
import { parse } from "acorn";

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
    return { checked: false, issues: [] };
  }

  const issues = [];
  blocks.forEach((code, i) => {
    try {
      parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
    } catch (err) {
      issues.push({
        blockIndex: i,
        category:   "syntax",
        description: `Code block ${i + 1} has a syntax error: ${err.message}`,
        severity:   "blocking",
      });
    }
  });

  return { checked: true, issues };
};