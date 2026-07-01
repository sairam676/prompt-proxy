/**
 * byollm.js — Bring Your Own LLM
 * 
 * Instead of you paying for every final call, the user connects their
 * own Claude/OpenAI API key. You become pure middleware: you optimize
 * the prompt, they pay their own provider directly with their own credits.
 * 
 * Their key is NEVER stored in plaintext server-side beyond the request —
 * passed per-request, used once, discarded. Or optionally encrypted in
 * Redis with a short TTL if they want to save it for the session.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Supported providers ─────────────────────────────────────────────────────────
export const PROVIDERS = {
  claude: {
    name:   "Claude",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-4-6",
  },
  openai: {
    name:   "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    defaultModel: "gpt-4o-mini",
  },
};

// ── Call user's own LLM with their own key ────────────────────────────────────
/**
 * @param {string} provider     "claude" | "openai"
 * @param {string} apiKey       user's own API key (never logged or stored)
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options      { model, maxTokens }
 */
export const callUserLLM = async (provider, apiKey, systemPrompt, userPrompt, options = {}) => {
  if (!apiKey) throw new Error("No API key provided — connect your account first");

  if (provider === "claude") {
    const client = new Anthropic({ apiKey });
    const model  = options.model ?? PROVIDERS.claude.defaultModel;

    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 512,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    return {
      text:         response.content[0].text,
      inputTokens:  response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens:  response.usage.input_tokens + response.usage.output_tokens,
      model:        response.model,
      provider:     "claude",
      usage: {
        input_tokens:  response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey });
    const model  = options.model ?? PROVIDERS.openai.defaultModel;

    const response = await client.chat.completions.create({
      model,
      max_tokens: options.maxTokens ?? 512,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    });

    return {
      text:         response.choices[0].message.content,
      inputTokens:  response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      totalTokens:  response.usage.total_tokens,
      model:        response.model,
      provider:     "openai",
      usage: {
        input_tokens:  response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      },
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
};

// ── Validate a key works before using it (quick ping) ─────────────────────────
export const validateApiKey = async (provider, apiKey) => {
  try {
    if (provider === "claude") {
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      return { valid: true };
    }
    if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      return { valid: true };
    }
    return { valid: false, error: "Unsupported provider" };
  } catch (err) {
    return { valid: false, error: err.message };
  }
};