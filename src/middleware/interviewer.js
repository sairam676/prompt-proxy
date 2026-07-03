import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const MAX_TURNS = 4;

/**
 * CORE PHILOSOPHY:
 * The middleware acts like a senior engineer briefing an expert consultant.
 * Before the expensive LLM sees anything, we extract:
 *   - What exactly is the problem / goal
 *   - What the user has already (code, error, context)
 *   - What was already tried
 *   - What "done" looks like
 *
 * This means the big LLM gets ONE perfect request instead of
 * 10 vague back-and-forth messages — saving hours of debugging time
 * and 60-80% of tokens.
 */

const INTERVIEWER_SYSTEM_PROMPT = `
You are a context extraction expert. Your job is to get everything needed 
to solve any problem in ONE shot — no back and forth, no guessing.

The #1 cause of wrong answers and wasted tokens:
Getting a description of the problem instead of the actual problem.

For ANY task, figure out what the "actual thing" is and ask for it:
- Bug or error → paste the exact error + the code
- Something not working → what it does vs what it should do
- Write something → who it's for, what it should achieve, any examples to match
- Analyze something → paste the actual data, text, or content
- Build something → what already exists, exact requirements
- Explain something → what they already know, what's confusing them
- Fix or improve something → paste the current version

Rules:
1. Never attempt the task yourself.
2. Ask ONE question at a time — the single most critical missing piece.
3. Always ask for things to be PASTED, not described.
4. Stop when you have enough to solve it without guessing anything.
5. If the user pastes rich context upfront — output JSON immediately, no questions.
6. Never ask about things that don't change the answer.
7. Never include null fields in the JSON — only include what you actually have.

When ready, output ONLY this JSON:
{
  "ready": true,
  "structured_context": {
    "goal": "exact task — specific and verb-led",
    "existing_context": "actual pasted content — code, text, data, error, draft",
    "already_tried": "what already failed — only if mentioned",
    "expected_output": "what success looks like",
    "constraints": "limits, versions, platform, length — only if relevant",
    "domain": "subject area or technology",
    "raw_intent": "user's original message verbatim",
    "complexity": "simple|medium|complex"
  }
}

Omit any field with no real content. Output ONLY the JSON when ready.
`.trim();

export const runInterviewTurn = async (userMessage, history = []) => {
  const updatedHistory = [...history, { role: "user", content: userMessage }];

  const response = await client.chat.completions.create({
    model:      "llama-3.3-70b-versatile",
    messages:   [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...updatedHistory,
    ],
    max_tokens: 300,
  });

  const reply = response.choices[0].message.content.trim();

  // Extract JSON even if Llama leaks surrounding text
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
  const response = await client.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...history,
      {
        role:    "user",
        content: "That's all the context I have. Build the best brief you can from what I've told you. Set unknown fields to null.",
      },
    ],
    max_tokens: 500,
  });

  const reply = response.choices[0].message.content.trim();

  const jsonMatch = reply.match(/\{[\s\S]*"structured_context"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.structured_context ?? parsed;
    } catch (_) {}
  }

  const lastUser = [...history].reverse().find((m) => m.role === "user");
  return {
    goal:             lastUser?.content ?? "complete the task",
    existing_context: null,
    already_tried:    null,
    expected_output:  null,
    constraints:      null,
    domain:           null,
    raw_intent:       lastUser?.content ?? "",
    complexity:       "medium",
  };
};