/**
 * interpreter.js
 * 
 * Step 3 of the pipeline — our Groq model takes the user's LLM response
 * and breaks it down into clear, actionable output.
 * 
 * The user doesn't just get the raw LLM answer.
 * They get: what to do, why it works, what to test, what could go wrong.
 */

import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const INTERPRETER_PROMPT = `
You are a solution interpreter. Given an LLM's response to a problem, 
break it down into clear actions the user can take immediately.

Output ONLY this JSON — no text before or after:
{
  "summary": "one sentence — what the solution actually does",
  "fix": "the exact thing to do — specific, actionable, no fluff",
  "why_it_works": "brief explanation of why this fixes the root cause",
  "steps": ["step 1", "step 2", "step 3"],
  "what_to_test": "exactly what to run/check to verify it worked",
  "what_could_go_wrong": "the most likely thing that could still fail and why",
  "next_action": "the single most important thing to do right now"
}

Be specific. Reference the actual code/error/content. Never be generic.
`.trim();

export const interpretResponse = async (llmResponse, analysis, onStep) => {
  onStep({ type: "status", message: "Interpreting the solution..." });

  const response = await groq.chat.completions.create({
    model:      "llama-3.3-70b-versatile",
    max_tokens: 800,
    messages: [
      { role: "system", content: INTERPRETER_PROMPT },
      {
        role:    "user",
        content: `Root cause identified: ${analysis.root_cause}\n\nLLM Response:\n${llmResponse}`,
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Interpreter failed to return valid JSON");

  const interpretation = JSON.parse(jsonMatch[0]);

  onStep({
    type:    "interpretation_done",
    message: "Solution interpreted",
    data:    interpretation,
  });

  return interpretation;
};