/**
 * syntaxVerifier.js
 *
 * Deterministic syntax check — does the fixed code actually parse as valid
 * JavaScript. This is a fact (parses / doesn't parse), not an opinion, same
 * category as fixVerifier.js's npm check. Doesn't run the code, doesn't
 * check logic — just catches "this wouldn't even load."
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

  let candidates;
  if (blocks.length > 0) {
    candidates = blocks;
  } else {
    // No fenced blocks — try to isolate the code-like portion of the raw
    // message rather than parsing English + code together, which breaks
    // acorn immediately on the prose. Take contiguous lines that look like
    // code, starting from the first such line.
    const lines = llmResponse.split("\n");
    const codeLines = [];
    let inCode = false;
    for (const line of lines) {
      const lineLooksLikeCode = /function\s|=>|const\s|let\s|var\s|require\(|import\s|^\s*\}|^\s*\{|;\s*$/.test(line);
      if (lineLooksLikeCode) inCode = true;
      if (inCode) codeLines.push(line);
    }
    candidates = codeLines.length > 0 ? [codeLines.join("\n")] : [];
  }

  if (!candidates.length) {
    return { checked: false, issues: [] };
  }

  const issues = [];
  candidates.forEach((code, i) => {
    try {
      JSXParser.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
      });
    } catch (err) {
      if (looksLikeCode(code)) {
        issues.push({
          blockIndex: i,
          category:   "syntax",
          description: `Code has a syntax error: ${err.message}`,
          severity:   "blocking",
        });
      }
    }
  });

  return { checked: true, issues };
};