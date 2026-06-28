/**
 * claude.js
 * Final Claude API call — uses dynamic max_tokens from task classification.
 * Returns text + actual usage for ground-truth token tracking.
 */

import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * @param {string} systemPrompt   Built by promptBuilder
 * @param {string} userPrompt     Built by promptBuilder
 * @param {object} options
 *   model         — defaults to llama-3.3-70b-versatile
 *   maxTokens     — from BUDGET_TEMPLATES[taskType].maxOutputTokens (dynamic!)
 *   stream        — false by default
 */
export const callClaude = async (systemPrompt, userPrompt, options = {}) => {
  const {
    model     = "llama-3.3-70b-versatile",
    maxTokens = 512,          // should always be overridden by taskClassifier
    stream    = false,
  } = options;

  if (stream) {
    return client.messages.stream({
      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });
  }

const response = await client.chat.completions.create({
  model,
  max_tokens: maxTokens,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ],
});

 return {
  text:         response.choices[0].message.content,
  inputTokens:  response.usage.prompt_tokens,
  outputTokens: response.usage.completion_tokens,
  totalTokens:  response.usage.total_tokens,
  model:        response.model,
  stopReason:   response.choices[0].finish_reason,
  usage: {
    input_tokens:  response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
  },
};
};