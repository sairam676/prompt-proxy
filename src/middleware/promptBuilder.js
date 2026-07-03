/**
 * promptBuilder.js
 *
 * Turns the structured brief into one perfect prompt for the big LLM.
 * The brief contains everything the LLM needs — no guessing required.
 *
 * Structure: Role → Problem → Context → What was tried → Expected output → Format
 * This is how a senior engineer would write a ticket for an expert consultant.
 */

export const buildSystemPrompt = (ctx, taskType = "factual") => {
  const roleMap = {
    code:           "You are an expert software engineer.",
    analysis:       "You are a rigorous, expert analyst.",
    creative:       "You are a skilled, professional writer.",
    transformation: "You are an expert editor.",
    summarization:  "You are a concise, accurate summarizer.",
    factual:        "You are a knowledgeable, accurate assistant.",
  };

  const role = ctx.domain
    ? `You are an expert in ${ctx.domain}.`
    : roleMap[taskType] ?? roleMap.factual;

  return `${role} You are given a complete brief. Solve it precisely and completely. Do not ask follow-up questions. Do not add preamble or sign-off. Output only what was asked.`;
};

export const buildOptimizedPrompt = (ctx, taskType = "factual") => {
  const parts = [];

  // 1. The goal — what needs to be done
  parts.push(`## Task\n${ctx.goal || ctx.raw_intent}`);

  // 2. Existing context — what they already have
  // This is the most important section — prevents the LLM from
  // building from scratch when the user has existing work
  if (ctx.existing_context) {
    parts.push(`## Existing context\n${ctx.existing_context}`);
  }

  // 3. What was already tried — prevents repeating failed solutions
  if (ctx.already_tried) {
    parts.push(`## Already tried (do not repeat these)\n${ctx.already_tried}`);
  }

  // 4. Expected output — what success looks like
  if (ctx.expected_output) {
    parts.push(`## Expected output\n${ctx.expected_output}`);
  }

  // 5. Constraints — stack, version, platform, limits
  if (ctx.constraints) {
    parts.push(`## Constraints\n${ctx.constraints}`);
  }

  // 6. Output format — tells the LLM exactly how to structure the response
  parts.push(`## Output format\n${buildFormatInstruction(ctx, taskType)}`);

  return parts.join("\n\n");
};

const buildFormatInstruction = (ctx, taskType) => {
  if (ctx.expected_output) {
    // User already told us what success looks like — use that
    return `Match the expected output described above exactly.`;
  }

  const formatDefaults = {
    code:           "Working code only. Use markdown code blocks. Add comments only where logic is non-obvious. No explanation unless asked.",
    analysis:       "Structured analysis. Use headers for each dimension. Be specific — no vague generalities.",
    creative:       "Prose only. No headers. No meta-commentary. Write the content directly.",
    transformation: "The transformed content only. No explanation of what you changed.",
    summarization:  "Bullet points. One sentence each. Most important point first. Maximum 5 bullets.",
    factual:        "Direct answer first. Brief explanation after if needed. No padding.",
  };

  return formatDefaults[taskType] ?? formatDefaults.factual;
};