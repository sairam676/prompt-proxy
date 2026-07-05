import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const EXTRACTOR_PROMPT = `
You are a deep problem analyst. Given the user's full context, produce a complete analysis.

CRITICAL: The user has already provided their context. Do NOT say anything is missing.
Work with what you have. If the context is rich — use it fully.

Think:
1. What is the actual root cause or core challenge?
2. What does the user specifically need based on their context?
3. What surgical prompt will get the best response from an expert LLM?

The surgical_prompt must include ALL the user's actual content — their resume, code, JD, error — everything.
The expert LLM only sees this prompt. Make it complete.

Output ONLY this JSON:
{
  "root_cause": "the actual root cause or core challenge — specific",
  "problem_area": "exactly what area is affected",
  "severity": "low|medium|high",
  "complexity": "simple|medium|complex",
  "key_insight": "something important the user may not have realized",
  "surgical_prompt": "complete prompt for the expert LLM — include ALL user context verbatim",
  "what_to_verify": "how to confirm the solution worked",
  "potential_risks": "what could still go wrong"
}
`.trim();

export const extractAndAnalyze = async (userContext, onStep) => {
  onStep({ type: "status", message: "Analyzing your problem..." });

  const response = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: EXTRACTOR_PROMPT },
      { role: "user",   content: formatContext(userContext) },
    ],
    response_format: { type: "json_object" },
  });

  const analysis = JSON.parse(response.choices[0].message.content.trim());

  onStep({
    type:    "extraction_done",
    message: "Problem analyzed",
    data: {
      rootCause:   analysis.root_cause,
      problemArea: analysis.problem_area,
      severity:    analysis.severity,
      complexity:  analysis.complexity,
      keyInsight:  analysis.key_insight,
    },
  });

  return analysis;
};

const formatContext = (ctx) => {
  const parts = [];
  if (ctx.goal)             parts.push(`Goal: ${ctx.goal}`);
  if (ctx.existing_context) parts.push(`User's full context:\n${ctx.existing_context}`);
  if (ctx.already_tried)    parts.push(`Already tried: ${ctx.already_tried}`);
  if (ctx.expected_output)  parts.push(`Expected outcome: ${ctx.expected_output}`);
  if (ctx.constraints)      parts.push(`Constraints: ${ctx.constraints}`);
  if (ctx.domain)           parts.push(`Domain: ${ctx.domain}`);
  return parts.join("\n\n");
};