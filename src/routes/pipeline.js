/**
 * pipeline.js
 * 
 * SSE endpoint — streams each pipeline step to the frontend in real time.
 * User sees exactly what's happening as it happens.
 * 
 * POST /api/pipeline/run
 * Body: { sessionId, provider, apiKey }
 * 
 * For testing: if no apiKey provided, falls back to TEST_LLM_KEY from .env
 */

import express from "express";
import { getSession, saveSession } from "../services/sessionStore.js";
import { runInterviewTurn, forceExtractContext } from "../middleware/interviewer.js";
import { runPipeline } from "../pipeline/runner.js";
import { createSession, getSession as getsess } from "../services/sessionStore.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// ── POST /api/pipeline/start ──────────────────────────────────────────────────
// Start interview — same as before
router.post("/start", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const sessionId = uuidv4();
    const { createSession } = await import("../services/sessionStore.js");
    const session = await createSession(sessionId, message.trim());

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
    return res.json({ sessionId, status: "interviewing", question: result.question });
  } catch (err) {
    console.error("[/pipeline/start]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/pipeline/reply ──────────────────────────────────────────────────
router.post("/reply", async (req, res) => {
  try {
    const { sessionId, message, done: userDone } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (userDone) {
      const context = await forceExtractContext(session.history);
      session.structuredContext = context;
      session.status            = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

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
    return res.json({ sessionId, status: "interviewing", question: result.question });
  } catch (err) {
    console.error("[/pipeline/reply]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pipeline/run/:sessionId ─────────────────────────────────────────
// SSE endpoint — streams pipeline steps live to the frontend
router.get("/run/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const provider = req.query.provider ?? process.env.TEST_LLM_PROVIDER ?? "claude";
  const apiKey   = req.query.apiKey   ?? process.env.TEST_LLM_KEY;

  if (!apiKey) {
    return res.status(400).json({ error: "No API key provided" });
  }

  // Set up SSE
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const session = await getSession(sessionId);
    if (!session) {
      send({ type: "error", message: "Session not found" });
      return res.end();
    }
    if (session.status !== "complete") {
      send({ type: "error", message: "Interview not complete" });
      return res.end();
    }
console.log("CTX:", JSON.stringify(session.structuredContext, null, 2));
    await runPipeline(session.structuredContext, provider, apiKey, send);
  } catch (err) {
    console.error("[/pipeline/run]", err);
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

export default router;