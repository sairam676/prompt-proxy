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

export const verifySyntax = (llmResponse) => {
  const blocks = extractCodeBlocks(llmResponse);

  // Fallback: no fenced code blocks found — the message might still BE
  // code, just pasted raw without ``` fences. Try parsing it directly
  // rather than silently skipping the check.
  const candidates = blocks.length > 0 ? blocks : [llmResponse];

  const issues = [];
  candidates.forEach((code, i) => {
    try {
      JSXParser.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
      });
    } catch (err) {
      // Only report as an issue if this looks like it was actually meant
      // to be code — avoid flagging plain English text as a syntax error.
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