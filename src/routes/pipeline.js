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
import { getSession, saveSession, createSession } from "../services/sessionStore.js";
import { runInterviewTurn, forceExtractContext } from "../middleware/interviewer.js";
import { runPipeline } from "../pipeline/runner.js";
import { v4 as uuidv4 } from "uuid";
import { verifySyntax } from "../pipeline/syntaxVerifier.js";
import { classifyTaskType } from "../pipeline/taskRouter.js";
import multer from "multer";
import { extractZipForSession, listFiles } from "../pipeline/fileContext.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = express.Router();

/**
 * buildAttachedFilesContext — used whenever a session has files attached
 * via zip upload. Skips the interviewer entirely: the interviewer has no
 * visibility into /upload-context, so leaving it in the loop means it
 * keeps asking the user to paste code that will never come. This builds a
 * minimal structuredContext directly and marks the session complete.
 */
const buildAttachedFilesContext = (session, message) => ({
  goal: message?.trim() || session.history?.[0]?.content || "debug the attached project",
  existing_context: `Project files attached via zip upload: ${
    session.attachedFileList?.join(", ") ?? "see attached files"
  }. Use read_file/list_files to inspect them before diagnosing.`,
  already_tried: null,
  expected_output: null,
  constraints: null,
  domain: null,
  raw_intent: message?.trim() || session.history?.[0]?.content || "",
  complexity: "medium",
});

// ── POST /api/pipeline/start ──────────────────────────────────────────────────
router.post("/start", async (req, res) => {
  try {
    const { message, mode } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const sessionId = uuidv4();
    const session = await createSession(sessionId, message.trim());
    const taskType = await classifyTaskType(message, mode);
    session.taskType = taskType;

    // Deterministic pre-check: only for explicitly fenced (```) code
    // blocks. Raw unfenced text is NOT guessed at — that heuristic kept
    // false-positiving on ordinary English (apostrophes, the word
    // "function" used as a noun, prose mixed with code). Fenced blocks are
    // an unambiguous signal the user intentionally marked as code.
    if (taskType === "debug") {
      const syntaxCheck = verifySyntax(message);
      if (syntaxCheck.checked && syntaxCheck.issues.length > 0) {
        return res.json({
          sessionId,
          status: "complete_syntax_only",
          syntaxIssues: syntaxCheck.issues,
          message: "Found a syntax error directly — no need to call your LLM for this one.",
        });
      }
    }

    // General/conceptual questions skip the interview entirely — there's
    // no code to gather context on, no error to reproduce.
    if (taskType === "general") {
      session.structuredContext = {
        goal: message.trim(),
        existing_context: null,
        already_tried: null,
        expected_output: null,
        constraints: null,
        domain: null,
        raw_intent: message.trim(),
        complexity: "simple",
      };
      session.status = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete", taskType });
    }

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
    if (!sessionId || (!message?.trim() && !userDone))
      return res.status(400).json({ error: "sessionId is required, and message unless done:true" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // If a project zip is attached and we're not already past the
    // interview, skip the interviewer entirely — see buildAttachedFilesContext.
    if (session.hasAttachedFiles && session.status !== "complete") {
      session.structuredContext = buildAttachedFilesContext(session, message);
      session.status = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    // Clarification answer: the real LLM (not a cheap pre-filter) said it
    // needed more info to diagnose confidently and asked a specific
    // question. Fold the answer into existing_context, tagged as
    // confirmed — never re-hedged as an assumption on a later pass.
    if (session.awaitingTieBreak) {
      const ctx = session.structuredContext ?? {};
      ctx.existing_context = ctx.existing_context
        ? `${ctx.existing_context}\n\n[CONFIRMED BY USER]: ${message}`
        : `[CONFIRMED BY USER]: ${message}`;
      ctx.raw_intent = `${ctx.raw_intent ?? ""}\n\n${message}`;

      session.structuredContext = ctx;
      session.status             = "complete";
      session.awaitingTieBreak   = false;
      session.tieBreakQuestion   = null;
      await saveSession(sessionId, session);

      return res.json({ sessionId, status: "complete", resumedFromTieBreak: true });
    }

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

// ── POST /api/pipeline/upload-context ─────────────────────────────────────────
router.post("/upload-context", upload.single("zip"), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId || !req.file) return res.status(400).json({ error: "sessionId and zip file required" });

    extractZipForSession(sessionId, req.file.buffer);
    const files = listFiles(sessionId);

    // Mark the session so /reply and /start know a project was attached —
    // the interviewer otherwise has zero visibility into this upload and
    // would keep asking for pasted code that will never come.
    const session = await getSession(sessionId);
    if (session) {
      session.hasAttachedFiles = true;
      session.attachedFileList = files;
      await saveSession(sessionId, session);
    }

    return res.json({ status: "ok", fileCount: files.length, files: files.slice(0, 50) });
  } catch (err) {
    console.error("[/upload-context]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pipeline/run/:sessionId ─────────────────────────────────────────
// SSE endpoint — streams pipeline steps live to the frontend
router.get("/run/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const provider = req.query.provider ?? process.env.TEST_LLM_PROVIDER ?? "gemini";
  const apiKey   = req.query.apiKey   ?? process.env.TEST_LLM_KEY;

  if (!apiKey) {
    return res.status(400).json({ error: "No API key provided" });
  }

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

    const result = await runPipeline(session.structuredContext, provider, apiKey, sessionId, send);

    // Real LLM said it needs clarification — hand the question back to the
    // frontend as "needs_info". No hypothesis state to persist — the next
    // answer just enriches the context for a fresh call.
    if (result?.blocked && result.reason === "needs_clarification") {
      session.status           = "interviewing";
      session.awaitingTieBreak = true;
      session.tieBreakQuestion = result.tieBreakQuestion;
      await saveSession(sessionId, session);

      send({ type: "needs_info", message: result.tieBreakQuestion });
      return res.end();
    }

    // Successful run — nothing to persist for next time
  } catch (err) {
    console.error("[/pipeline/run]", err);
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

export default router;