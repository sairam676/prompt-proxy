/**
 * interviewer.js
 * The middleware LLM — asks targeted questions to extract structured context.
 * Uses claude-haiku (cheap) — intelligence not needed here, structure is.
 *
 * Key design: one system prompt is the ONLY maintenance surface.
 * No per-domain rules. Haiku figures out what's missing from any task.
 */

import Groq from "groq-sdk";
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const MAX_TURNS = 4;

// ── The core system prompt ────────────────────────────────────────────────────
// This is your IP. Tune this, not individual task handlers.

const INTERVIEWER_SYSTEM_PROMPT = `
You are a context extraction agent. Your job is to ask the user for information 
that ONLY THEY know — facts that cannot be found on the internet or inferred from 
general knowledge. This is what prevents the LLM from hallucinating.

## THE GOLDEN RULE:
Ask for USER-SPECIFIC facts first. These are things like:
- Their actual code, error message, stack trace
- Their project name, what it does, GitHub link, tech stack
- Their company, role, audience, relationship
- Their specific numbers, versions, constraints
- What they have already tried

## LAZY LADDER — before asking anything, check:
1. Is the goal 100% clear?                    → if not, ask about it first
2. Are there user-specific facts missing?     → if yes, ask for them NOW
3. Is the format/length obvious?              → if not, ask
4. Do I have enough to build a complete prompt with ZERO assumptions? → if yes, output JSON

## RULES:
1. NEVER answer the task yourself.
2. Ask ONE question at a time.
3. Maximum 3 questions. Stop earlier if you have enough.
4. NEVER ask about things you can infer (tone of a LinkedIn post = professional, code = concise)
5. If the user gives you enough specifics upfront — output JSON immediately, no questions.

## WHAT CAUSES HALLUCINATION (always extract these if relevant):
- Missing actual code/error → LLM guesses the bug
- Missing project description → LLM invents features  
- Missing real numbers/metrics → LLM makes up statistics
- Missing existing context → LLM assumes from scratch
- Missing what was tried → LLM repeats failed solutions

## OUTPUT JSON when ready — nothing else before or after:
{
  "ready": true,
  "structured_context": {
    "goal": "specific verb-led task",
    "audience": null,
    "tone": null,
    "format": null,
    "constraints": null,
    "domain_context": null,
    "raw_intent": "user's original words verbatim",
    "complexity": "simple|medium|complex",
    "user_specifics": "all the user-specific facts collected"
  }
}
`.trim();

// ── Single interview turn ─────────────────────────────────────────────────────

/**
 * Run one turn of the interview.
 * @param {string} userMessage  Latest message from user
 * @param {Array}  history      Full prior [{role, content}] pairs
 * @returns {{ done, question?, context?, history, usage }}
 */
export const runInterviewTurn = async (userMessage, history = []) => {
  const updatedHistory = [...history, { role: "user", content: userMessage }];

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...updatedHistory,
    ],
    max_tokens: 300,
  });

  const reply = response.choices[0].message.content.trim();

  // Try to extract JSON even if mixed with text
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

  // Strip any JSON blob from the question before showing to user
  const cleanReply = reply.replace(/\{[\s\S]*\}/, "").trim();

  const nextHistory = [...updatedHistory, { role: "assistant", content: reply }];
  return {
    done:     false,
    question: cleanReply || reply,
    history:  nextHistory,
    usage:    response.usage,
  };
};


// ── Force extract (safety valve) ──────────────────────────────────────────────

/**
 * Called when MAX_TURNS is reached without completion.
 * Forces the interviewer to extract whatever context it has.
 * Prevents infinite loops — always returns something usable.
 */
export const forceExtractContext = async (history) => {
  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERVIEWER_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: "That's all the information I have. Please output the structured_context JSON now with what you know. Set unknown fields to null." },
    ],
    max_tokens: 400,
  });

  const reply = response.choices[0].message.content.trim();

  // Extract JSON even if mixed with text
  const jsonMatch = reply.match(/\{[\s\S]*"structured_context"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.structured_context ?? parsed;
    } catch (_) {}
  }

  // Last resort fallback
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  return {
    goal:           lastUser?.content ?? "complete the user's request",
    audience:       null,
    tone:           null,
    format:         null,
    constraints:    null,
    domain_context: null,
    raw_intent:     lastUser?.content ?? "",
  };
};