import Groq from "groq-sdk";
import { auditEvidence } from "./evidenceAudit.js";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const INTERPRETER_PROMPT = `
You are a solution interpreter. Given the LLM's response, break it down into 
everything the user needs to act on it immediately.

CRITICAL: If the LLM response contains code — include it VERBATIM in an output_section 
with type "code". Never summarize or describe code. Show the actual code.

Be comprehensive. Do not artificially shorten. Every important piece of information 
from the LLM response must surface in your output.

RELEVANCE CONSTRAINT (strict):
The LLM response IS the diagnosis, fix, and self-critique in one — it was asked to
diagnose with cited evidence, fix, and self-critique itself in a single response.
Extract its stated diagnosis (and self-critique, if present) into their own
output_sections so the user can see the reasoning, not just the fix.

EVIDENCE / ASSUMPTIONS / CONFIDENCE (when present in the LLM response):
If the LLM response includes lines prefixed "✓" (evidence), "?" (assumptions),
a stated confidence percentage, or alternative hypotheses — extract these into
their own top-level fields (see schema below), verbatim in meaning, not
reworded to sound more or less certain than the LLM actually stated. Do not
invent a confidence score or evidence/assumption split if the LLM response
didn't include one (e.g. simple mechanical-bug responses skip this
entirely — that's expected, leave these fields null/empty in that case).

Do NOT include generic infrastructure suggestions (load balancing, database
connection pooling, Kafka, Kubernetes tuning, caching layers, etc.) unless the
user's own context specifically mentions that system already being in use.

If the LLM response itself lists multiple alternative approaches to the SAME
issue (e.g. "you could use Redis, or Memcached, or..."): pick the ONE most
standard approach and present ONLY that as the fix, with its full code. Mention
alternatives, if at all, in one sentence inside an "Optional" section.

If the LLM diagnosed multiple genuinely distinct issues (it was told to, if the
context described more than one): give each its own clearly labeled fix with its
own full code, tagged with which issue it addresses — don't merge them, don't
present them as a menu.

Anything genuinely useful but not essential to any of the diagnosed issues goes in
exactly ONE section titled "Optional" — never mixed into the main output_sections.

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
  "confidence": 78,
  "evidence": ["directly observed fact from the LLM response", "..."],
  "assumptions": ["unverified assumption the diagnosis depends on, if any", "..."],
  "alternative_hypotheses": [
    { "theory": "alternative explanation", "confidence": 15 }
  ],
  "output_sections": [
    {
      "title": "section title",
      "content": "complete detailed content — for code sections paste verbatim",
      "type": "text|code|list|steps|warning|tip",
      "issue_id": "which diagnosed issue this addresses — omit if there's only one diagnosis",
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
          key_insight:  analysis.key_insight,
          llm_response: llmResponse,
          verification: verification ?? { status: "unverified", issues: [], notes: "No verifier run." },
        }),
      },
    ],
    response_format: { type: "json_object" },
  });

  const interpretation = JSON.parse(response.choices[0].message.content.trim());

  // Fallback enforcement: don't trust the LLM to remember verification_status
  // on every code section. If it forgot, attach the actual verifier result
  // directly so the UI always has something to show.
  if (interpretation.output_sections?.length && verification?.status) {
    interpretation.output_sections = interpretation.output_sections.map(section => {
      if (section.type === "code" && !section.verification_status) {
        return {
          ...section,
          verification_status: verification.status,
          ...(verification.status === "rejected" && {
            verification_note: verification.notes || verification.issues?.map(i => i.description).join("; "),
          }),
        };
      }
      return section;
    });
  }

  // Deterministic evidence-grounding check — a fact-check on the LLM's own
  // "✓" evidence claims against the user's actual pasted code, not a second
  // model's opinion about whether the diagnosis is correct. Surfaces
  // ungrounded claims as a flag; never silently rejects or overrides.
  const audit = auditEvidence(llmResponse, userContext.existing_context ?? "");
  if (audit.hasUngroundedClaims) {
    interpretation.evidence_audit_warning =
      `${audit.ungroundedCount} evidence claim(s) referenced identifiers not found in your pasted code — worth double-checking these before trusting the diagnosis.`;
  }
  interpretation.evidence_audit = audit;

  onStep({
    type:    "interpretation_done",
    message: "Action plan ready",
    data:    { summary: interpretation.summary, confidence: interpretation.confidence },
  });

  return interpretation;
};