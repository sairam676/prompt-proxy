import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const callClaude = async (systemPrompt, userPrompt, options = {}) => {
  const { model = "llama-3.3-70b-versatile", maxTokens = 512 } = options;

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

export const callClaudeDecomposed = async (systemPrompt, subtasks) => {
  let totalInput  = 0;
  let totalOutput = 0;
  let context     = "";
  const steps     = [];

  for (const subtask of subtasks) {
    const prompt = context
      ? `${context}\n\n---\nNext step: ${subtask.prompt}`
      : subtask.prompt;

    const response = await client.chat.completions.create({
      model:      subtask.model.id,
      max_tokens: subtask.model.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: prompt },
      ],
    });

    const output = response.choices[0].message.content;
    totalInput  += response.usage.prompt_tokens;
    totalOutput += response.usage.completion_tokens;

    steps.push({
      id:     subtask.id,
      name:   subtask.name,
      model:  subtask.model.id,
      output,
      tokens: response.usage.prompt_tokens + response.usage.completion_tokens,
    });

    context += `\n\n[${subtask.name}]\n${output}`;
  }

  return {
    text:         steps[steps.length - 1].output,
    steps,
    inputTokens:  totalInput,
    outputTokens: totalOutput,
    totalTokens:  totalInput + totalOutput,
    usage: {
      input_tokens:  totalInput,
      output_tokens: totalOutput,
    },
  };
};