import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const INTERPRETER_PROMPT = `
You are a solution interpreter. Given the LLM's response, break it down into 
everything the user needs to act on it immediately.

CRITICAL: If the LLM response contains code — include it VERBATIM in an output_section 
with type "code". Never summarize or describe code. Show the actual code.

Be comprehensive. Do not artificially shorten. Every important piece of information 
from the LLM response must surface in your output.

RELEVANCE CONSTRAINT (strict):
Every output_section must trace directly to the confirmed root cause, the key insight,
or a specifically confirmed risk. Do NOT include generic infrastructure suggestions
(load balancing, database connection pooling, Kafka, Kubernetes tuning, caching layers,
etc.) unless the user's own context specifically mentions that system already being in use.
If the LLM response includes such padding, drop it from the main sections.
Anything genuinely useful but not essential to the diagnosed cause goes in exactly ONE
section titled "Optional" — never mixed into the main output_sections.

Build output_sections dynamically based on what THIS task needs:
- Bug fix → exact fix with full corrected code, why it works, test steps, edge cases  
- Interview prep → topics, personal gaps, likely questions, day-by-day plan
- Writing → improved content, what changed, why
- Analysis → findings, implications, recommended actions
- Learning → core concept, mental model, common mistakes, next steps

VERIFICATION STATUS:
You will be given a verification result for the fix (status: verified/unverified/rejected,
plus any issues found). Tag each output_section that presents a fix or code with a
"verification_status" field matching one of: "verified", "unverified", "rejected".
- "verified": the verifier checked this and found no blocking issues.
- "unverified": the verifier could not confirm this (e.g. non-code sections, or insufficient info).
- "rejected": the verifier found a blocking issue — you MUST still show it, but add a
  "verification_note" field explaining what the verifier flagged, so the user isn't misled.
Sections that aren't code/fixes (e.g. explanations, next steps) can omit verification_status.

Output ONLY this JSON:
{
  "summary": "one precise sentence — what the solution provides",
  "primary_action": "the single most important thing to do right now",
  "output_sections": [
    {
      "title": "section title",
      "content": "complete detailed content — for code sections paste verbatim",
      "type": "text|code|list|steps|warning|tip",
      "verification_status": "verified|unverified|rejected|null",
      "verification_note": "only present if verification_status is rejected"
    }
  ],
  "what_to_verify": "how to confirm this worked",
  "what_could_go_wrong": "likely failure points",
  "follow_up": "what to do after this",
  "llm_missed": "important things the LLM didn't cover — null if complete"
}
`.trim();

export const interpretResponse = async (llmResponse, analysis, userContext, verification, onStep) => {
  onStep({ type: "status", message: "Building your action plan..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: INTERPRETER_PROMPT },
      {
        role:    "user",
        content: JSON.stringify({
          task:         userContext.goal ?? userContext.raw_intent,
          root_cause:   analysis.root_cause ?? analysis.diagnosis?.theory,
          key_insight:  analysis.key_insight,
          llm_response: llmResponse,
          verification: verification ?? { status: "unverified", issues: [], notes: "No verifier run." },
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