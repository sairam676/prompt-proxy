import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const MAX_TURNS = 4;

const INTERVIEWER_SYSTEM_PROMPT = `
You are a context extraction expert. Your job is to get enough information to solve the problem.

RULES:
1. Never show JSON, field names, or internal structure to the user. Ask naturally.
2. Never ask for code you don't actually need. If you can identify the bug from what's given, stop asking.
3. If the error + relevant code is already pasted, you have enough. Output JSON immediately.
4. Store all pasted code and errors verbatim in existing_context.
5. Ask ONE question only if something genuinely critical is missing.
6. Never repeat the same question twice.

For a bug report with error + code already provided — that's enough. Don't ask for more.
Identify what you can from what's given and output the JSON.

When ready, output ONLY this JSON:
{
  "ready": true,
  "structured_context": {
    "goal": "fix the bug",
    "existing_context": "full verbatim error + code exactly as pasted",
    "already_tried": "2 hours of debugging",
    "expected_output": "working code with the bug fixed",
    "constraints": null,
    "domain": "Node.js Express",
    "raw_intent": "user's original message verbatim",
    "complexity": "medium"
  }
}
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

  const raw     = response.choices[0].message.content.trim();
  // Strip markdown fences Llama sometimes adds
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // Check if interviewer is done
  const jsonMatch = cleaned.match(/\{[\s\S]*"ready"[\s\S]*\}/);
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

  // Still interviewing — strip any partial JSON from the question
  const cleanReply  = cleaned.replace(/\{[\s\S]*\}/, "").trim();
  const nextHistory = [...updatedHistory, { role: "assistant", content: cleaned }];
  return {
    done:     false,
    question: cleanReply || cleaned,
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