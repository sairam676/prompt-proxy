/**
 * chat.js
 *
 * What we do:
 * 1. Interview the user (LLM-driven, dynamic questions, no fixed limit)
 * 2. Check for missing critical facts that would cause hallucination
 * 3. Build a tight, structured prompt brief
 * 4. Return the prompt — user pastes it into their own LLM
 *
 * What we DON'T do:
 * - We never call the user's LLM
 * - We never charge per output token
 * - We don't store API keys
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";

import { runInterviewTurn, forceExtractContext } from "../middleware/interviewer.js";
import { buildOptimizedPrompt, buildSystemPrompt } from "../middleware/promptBuilder.js";
import { classifyTask }                            from "../middleware/taskClassifier.js";
import { checkCorrectness, calculateHallucinationRisk } from "../middleware/correctnessLayer.js";
import { tokenSavingsReport, countTokens }         from "../middleware/tokenEstimator.js";
import { cacheGet, cacheSet, hashContext }          from "../cache/redis.js";
import { createSession, getSession, saveSession }   from "../services/sessionStore.js";

const router = express.Router();

// ── POST /api/chat/start ──────────────────────────────────────────────────────
router.post("/start", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const sessionId = uuidv4();
    const session   = await createSession(sessionId, message.trim());

    // Interviewer LLM reads the message and decides what to ask
    // No templates. No pattern matching. Fully dynamic.
    const result = await runInterviewTurn(message, []);

    session.history   = result.history;
    session.turnCount = 1;
    session.interviewerTokensUsed =
      (result.usage?.prompt_tokens    ?? 0) +
      (result.usage?.completion_tokens ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({
      sessionId,
      status:    "interviewing",
      question:  result.question,
      turnCount: session.turnCount,
    });
  } catch (err) {
    console.error("[/start]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/reply ──────────────────────────────────────────────────────
router.post("/reply", async (req, res) => {
  try {
    const { sessionId, message, done: userDone } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session)
      return res.status(404).json({ error: "Session not found or expired" });
    if (session.status === "complete")
      return res.status(400).json({ error: "Session already complete" });

    // User explicitly says "that's all I have" — force extract and finish
    if (userDone) {
      const context             = await forceExtractContext(session.history);
      session.structuredContext = context;
      session.status            = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    // Continue — interviewer decides if it needs more or is ready
    const result = await runInterviewTurn(message, session.history);
    session.history    = result.history;
    session.turnCount += 1;
    session.interviewerTokensUsed =
      (session.interviewerTokensUsed    ?? 0) +
      (result.usage?.prompt_tokens      ?? 0) +
      (result.usage?.completion_tokens  ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({
      sessionId,
      status:    "interviewing",
      question:  result.question,
      turnCount: session.turnCount,
    });
  } catch (err) {
    console.error("[/reply]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/build ──────────────────────────────────────────────────────
// Build and return the optimized prompt. That's the product.
// User takes this and pastes it into Claude, GPT, Cursor, or any LLM they use.
router.post("/build", async (req, res) => {
  try {
    const { sessionId, forceExecute } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getSession(sessionId);
    if (!session)
      return res.status(404).json({ error: "Session not found or expired" });
    if (session.status !== "complete")
      return res.status(400).json({ error: "Interview not complete", status: session.status });

    const ctx = session.structuredContext;

    // Classify task type (for token budget + format defaults)
    const classification       = classifyTask(ctx);
    const { taskType, budget } = classification;

    // Correctness check — block if critical facts missing
    const correctness = checkCorrectness(ctx, taskType);
    const hallRisk    = calculateHallucinationRisk(ctx, taskType, correctness.missingCritical);

    if (correctness.blocked && !forceExecute) {
      return res.json({
        sessionId,
        status:            "needs_critical_info",
        warningMessage:    correctness.warningMessage,
        hallucinationRisk: hallRisk,
        canForceExecute:   true,
      });
    }

    // Cache check — same context = same prompt
    const contextHash = hashContext(ctx);
    const cached      = await cacheGet(contextHash);
    if (cached) return res.json({ ...cached, cacheHit: true });

    // Build the prompt
    const optimizedPrompt = buildOptimizedPrompt(ctx, taskType);
    const systemPrompt    = buildSystemPrompt(ctx, taskType);

    // Token savings vs naive prompting
    const savings = tokenSavingsReport(session.rawIntent, optimizedPrompt, systemPrompt);

    const payload = {
      optimizedPrompt,
      systemPrompt,
      structuredContext:     ctx,
      taskType,
      complexity:            ctx.complexity ?? "medium",
      classification:        { taskType, confidence: classification.confidence },
      savings,
      hallucinationRisk:     hallRisk,
      interviewerTokensUsed: session.interviewerTokensUsed ?? 0,
      promptTokenCount:      countTokens(optimizedPrompt) + countTokens(systemPrompt),
      maxOutputTokensSuggested: budget.maxOutputTokens,
      cacheHit:              false,
    };

    await cacheSet(contextHash, payload);
    return res.json(payload);
  } catch (err) {
    console.error("[/build]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/supplement ─────────────────────────────────────────────────
// User supplies missing critical info after correctness check blocked them
router.post("/supplement", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });

    const ctx = session.structuredContext ?? {};
    ctx.existing_context = ctx.existing_context
      ? `${ctx.existing_context}\n\n${message}` : message;
    ctx.raw_intent = `${ctx.raw_intent ?? ""}\n\n${message}`;

    session.structuredContext = ctx;
    session.status            = "complete";
    await saveSession(sessionId, session);

    return res.json({ sessionId, status: "complete" });
  } catch (err) {
    console.error("[/supplement]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/health ─────────────────────────────────────────────────────
router.get("/health", (_, res) => res.json({ status: "ok" }));

export default router;