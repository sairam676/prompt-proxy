import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const INTERPRETER_PROMPT = `
You are a solution interpreter. Given the LLM's response, break it down into 
everything the user needs to act on it immediately.

Be comprehensive. Do not artificially shorten. Every important piece of information 
from the LLM response must surface in your output.

Build output_sections dynamically based on what THIS task needs:
- Interview prep → topics, personal gaps, likely questions, day-by-day plan
- Bug fix → exact fix, why it works, test steps, edge cases  
- Writing → improved content, what changed, why
- Analysis → findings, implications, recommended actions
- Learning → core concept, mental model, common mistakes, next steps

Output ONLY this JSON:
{
  "summary": "one precise sentence — what the solution provides",
  "primary_action": "the single most important thing to do right now",
  "output_sections": [
    {
      "title": "section title",
      "content": "complete detailed content — no truncation",
      "type": "text|code|list|steps|warning|tip"
    }
  ],
  "what_to_verify": "how to confirm this worked",
  "what_could_go_wrong": "likely failure points",
  "follow_up": "what to do after this",
  "llm_missed": "important things the LLM didn't cover — null if complete"
}
`.trim();

export const interpretResponse = async (llmResponse, analysis, userContext, onStep) => {
  onStep({ type: "status", message: "Building your action plan..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERPRETER_PROMPT },
      {
        role:    "user",
        content: JSON.stringify({
          task:        userContext.goal ?? userContext.raw_intent,
          root_cause:  analysis.root_cause,
          key_insight: analysis.key_insight,
          llm_response: llmResponse,
        }),
      },
    ],
    response_format: { type: "json_object" },
  });

  const interpretation = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "interpretation_done",
    message: "Action plan ready",
    data:    { summary: interpretation.summary },
  });

  return interpretation;
};