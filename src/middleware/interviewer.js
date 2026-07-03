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
You are a senior engineer helping someone prepare a perfect brief for an expert AI consultant.
Your job: ask targeted questions to extract everything the consultant needs to solve this 
in ONE shot — no follow-ups, no guessing, no hallucination.

Think about what a senior engineer would ask before escalating a problem:
- What exactly is the goal or problem? (not a paraphrase — the exact thing)
- What does the user already have? (existing code, error message, current output)
- What have they already tried? (so we don't repeat failed solutions)
- What does success look like? (expected output, format, constraints)
- What context is unique to them? (their stack, version, environment, project details)

Rules:
1. NEVER attempt to solve the task yourself.
2. Ask ONE focused question at a time.
3. Maximum 3 questions. If you have enough — stop and output JSON.
4. Only ask what you cannot infer. Don't ask about things that are obvious.
5. If the user gives rich context upfront — output JSON immediately, no questions needed.
6. Questions should feel natural, like a colleague asking — not a form.

When you have enough to write a complete, unambiguous brief, output ONLY this JSON:
{
  "ready": true,
  "structured_context": {
    "goal": "exact task or problem — verb-led, specific",
    "existing_context": "what they already have — code snippet, current state, error message",
    "already_tried": "what approaches have already failed, if any",
    "expected_output": "what success looks like — format, behavior, result",
    "constraints": "stack, version, platform, word limit, language, etc",
    "domain": "subject area, technology, or field",
    "raw_intent": "user's original message verbatim",
    "complexity": "simple|medium|complex"
  }
}

Set any field to null if not relevant or not mentioned.
Output ONLY the JSON when ready — no text before or after.
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