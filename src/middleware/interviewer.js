import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const MAX_TURNS = 4;

const INTERVIEWER_SYSTEM_PROMPT = `
You are a context extraction expert. Extract everything needed to solve the user's problem in one shot.

CRITICAL RULE: When the user pastes a large block of text (resume, code, job description, error, data) — 
store it VERBATIM in existing_context. Never summarize it. Never paraphrase it. The full text must be preserved.

For any task, figure out:
- What exactly needs to be done
- What the user already has (paste it verbatim into existing_context)
- What they've already tried
- What success looks like

Rules:
1. Never attempt the task yourself.
2. Ask ONE question at a time — the most critical missing piece.
3. If the user pastes rich content upfront — output JSON immediately, no questions needed.
4. Never summarize pasted content — store it word for word.
5. Stop asking when you have enough to solve without guessing.

When ready, output ONLY this JSON:
{
  "ready": true,
  "structured_context": {
    "goal": "exact task — specific and verb-led",
    "existing_context": "FULL verbatim pasted content — resume, code, JD, error — word for word",
    "already_tried": "what already failed — null if not mentioned",
    "expected_output": "what success looks like",
    "constraints": "limits, versions, platform — null if none",
    "domain": "subject area or technology",
    "raw_intent": "user's original message verbatim",
    "complexity": "simple|medium|complex"
  }
}

Omit fields with no real content. Output ONLY the JSON when ready.
`.trim();

export const runInterviewTurn = async (userMessage, history = []) => {
  const updatedHistory = [...history, { role: "user", content: userMessage }];

  const response = await client.chat.completions.create({
    model:      "llama-3.3-70b-versatile",
    messages:   [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...updatedHistory,
    ],
    max_tokens: 600,
  });

  const reply = response.choices[0].message.content.trim();

  const jsonMatch = reply.match(/\{[\s\S]*"ready"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.ready && parsed.structured_context) {
        return {
          done:    true,
          context: parsed.structured_context,
          history: updatedHistory,
          usage:   response.usage,
        };
      }
    } catch (_) {}
  }

  const cleanReply = reply.replace(/\{[\s\S]*\}/, "").trim();
  const nextHistory = [...updatedHistory, { role: "assistant", content: reply }];
  return {
    done:     false,
    question: cleanReply || reply,
    history:  nextHistory,
    usage:    response.usage,
  };
};

export const forceExtractContext = async (history) => {
  // Build context directly from conversation history
  // Grab all user messages and concatenate — preserves full pasted content
  const userMessages = history
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join("\n\n");

  const response = await client.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...history,
      {
        role:    "user",
        content: "That's all the context I have. Build the structured_context JSON now. Store all pasted content verbatim in existing_context. Set unknown fields to null.",
      },
    ],
    max_tokens: 2000,
  });

  const reply = response.choices[0].message.content.trim();

  const jsonMatch = reply.match(/\{[\s\S]*"structured_context"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.structured_context ?? parsed;
    } catch (_) {}
  }

  // Fallback: build context directly from what user said
  const lastUser = [...history].reverse().find(m => m.role === "user");
  return {
    goal:             lastUser?.content ?? "complete the task",
    existing_context: userMessages,
    already_tried:    null,
    expected_output:  null,
    constraints:      null,
    domain:           null,
    raw_intent:       history[0]?.content ?? "",
    complexity:       "medium",
  };
};