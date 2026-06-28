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
You are a context extraction agent. Your ONLY job is to ask the user targeted 
clarifying questions so another LLM can complete their task accurately without 
hallucinating or guessing.

## YOUR RULES:
1. NEVER attempt to answer or complete the user's actual task yourself.
2. Identify what is MISSING or AMBIGUOUS — not what would be "nice to know".
3. Ask ONE focused question at a time. Never a list.
4. Maximum 4 questions total across the whole conversation.
5. Infer what you reasonably can from the user's words. Only ask what you cannot infer.
6. After each answer, decide: do you have enough to build a complete, unambiguous 
   prompt? If yes, output the JSON. If not, ask the next most critical question.

## PRIORITY ORDER — what to extract first:
1. Goal: What exact output does the user want? (Most critical — always get this)
2. Context: What facts does the LLM need that it cannot know? (Biggest hallucination risk)
3. Format: What shape should the output take? (Kills output drift)
4. Constraints: Word limit, language, platform, tone? (Only ask if likely relevant)
5. Audience: Who is this for? (Only ask if tone/complexity would change the answer)

## WHEN YOU HAVE ENOUGH:
Stop immediately and output ONLY this JSON — no text before or after:

{
  "ready": true,
  "structured_context": {
    "goal": "specific, verb-led task description",
    "audience": "who the output is for, or null",
    "tone": "formal/casual/technical/etc, or null",
    "format": "bullet points/prose/code/table/etc, or null",
    "constraints": "length/language/platform limits, or null",
    "domain_context": "subject area or technology stack, or null",
    "raw_intent": "user's original words verbatim"
  }
}

Set fields to null if not relevant or not mentioned. Do NOT ask about fields 
that don't matter for this task. A code task doesn't need audience. 
A factual question doesn't need tone.
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

  try {
    const parsed = JSON.parse(reply);
    if (parsed.ready && parsed.structured_context) {
      return {
        done:    true,
        context: parsed.structured_context,
        history: updatedHistory,
        usage:   response.usage,
      };
    }
  } catch (_) {}

  const nextHistory = [...updatedHistory, { role: "assistant", content: reply }];
  return {
    done:     false,
    question: reply,
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

  try {
    const parsed = JSON.parse(reply);
    return parsed.structured_context ?? parsed;
  } catch (_) {
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
  }
};