/**
 * extractor.js
 * 
 * Step 1 of the pipeline — our cheap Groq model extracts:
 * - What the actual problem is
 * - Root cause (if identifiable from context)
 * - What's missing that would prevent solving it
 * - Severity / complexity
 * 
 * This runs BEFORE the user's expensive LLM sees anything.
 * We never waste their credits on a vague prompt.
 */

import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const EXTRACTOR_PROMPT = `
You are a problem analysis expert. Given a user's problem, extract a structured analysis.

Output ONLY this JSON — no text before or after:
{
  "root_cause": "the most likely root cause based on what's provided — be specific",
  "problem_area": "what system/component/concept is affected",
  "severity": "low|medium|high",
  "complexity": "simple|medium|complex",
  "missing_critical": "what critical info is missing that would prevent solving this — null if nothing critical is missing",
  "surgical_prompt": "a tight, complete prompt for the user's LLM that will solve this in one shot — include all relevant context they provided",
  "what_to_verify": "what the user should check/test after applying the solution",
  "potential_risks": "what could go wrong with the solution"
}

Be specific. Use the actual content the user provided. Never be vague.
Never say 'the issue' — name the specific thing.
`.trim();

export const extractAndAnalyze = async (userContext, onStep) => {
  onStep({ type: "status", message: "Analyzing your problem..." });

  const response = await groq.chat.completions.create({
    model:      "llama-3.3-70b-versatile",
    max_tokens: 800,
    messages: [
      { role: "system", content: EXTRACTOR_PROMPT },
      { role: "user",   content: formatContext(userContext) },
    ],
  });

  const raw = response.choices[0].message.content.trim();

  // Extract JSON even if model leaks surrounding text
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Extractor failed to return valid JSON");

  const analysis = JSON.parse(jsonMatch[0]);

  onStep({
    type:    "extraction_done",
    message: "Problem analyzed",
    data:    {
      rootCause:   analysis.root_cause,
      problemArea: analysis.problem_area,
      severity:    analysis.severity,
      complexity:  analysis.complexity,
    },
  });

  return analysis;
};

const formatContext = (ctx) => {
  const parts = [];
  if (ctx.goal)             parts.push(`Problem: ${ctx.goal}`);
  if (ctx.existing_context) parts.push(`Context/Code/Error:\n${ctx.existing_context}`);
  if (ctx.already_tried)    parts.push(`Already tried: ${ctx.already_tried}`);
  if (ctx.expected_output)  parts.push(`Expected: ${ctx.expected_output}`);
  if (ctx.constraints)      parts.push(`Constraints: ${ctx.constraints}`);
  return parts.join("\n\n");
};