/**
 * syntaxVerifier.js
 *
 * Deterministic syntax check — does the fixed code actually parse as valid
 * JavaScript/JSX. This is a fact (parses / doesn't parse), not an opinion,
 * same category as fixVerifier.js's npm check. Doesn't run the code, doesn't
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

const looksLikeCode = (text) => /function\s|=>|const\s|let\s|var\s|\{|\}/.test(text);

const isolateCodeLines = (text) => {
  const lines = text.split("\n");
  const codeLines = [];
  let inCode = false;
  for (const line of lines) {
    const lineLooksLikeCode = /function\s|=>|const\s|let\s|var\s|require\(|import\s|^\s*\}|^\s*\{|;\s*$/.test(line);
    if (lineLooksLikeCode) inCode = true;
    if (inCode) codeLines.push(line);
  }
  return codeLines.join("\n");
};

export const verifySyntax = (llmResponse) => {
  const blocks = extractCodeBlocks(llmResponse);

  let candidates;
  if (blocks.length > 0) {
    candidates = blocks;
  } else {
    const isolated = isolateCodeLines(llmResponse);
    candidates = isolated.trim().length > 0 ? [isolated] : [];
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