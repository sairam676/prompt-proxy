// test-syntax.js — temporary, not part of the app
import { verifySyntax } from "./src/pipeline/syntaxVerifier.js";

const brokenResponse = `
Here's the fix:
\`\`\`javascript
function calculateTotal(items) {
  let total = 0
  for (const item of items {
    total += item.price
  }
  return total
}
\`\`\`
`;

console.log(JSON.stringify(verifySyntax(brokenResponse), null, 2));