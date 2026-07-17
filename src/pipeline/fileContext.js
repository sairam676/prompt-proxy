import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

/**
 * fileContext.js
 *
 * Handles the uploaded-zip -> extracted-files layer for the agentic
 * read_file tool. Scoped narrowly: this is NOT a live GitHub connection,
 * just a one-time zip upload per session, extracted to a per-session temp
 * directory so the read_file tool has something real to read from.
 */

const EXTRACT_ROOT = path.join(process.cwd(), "tmp", "sessions");

// Simple denylist to avoid the tool reading obviously irrelevant/huge
// directories if a user uploads a full project with node_modules etc.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

export const extractZipForSession = (sessionId, zipBuffer) => {
  const sessionDir = path.join(EXTRACT_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(sessionDir, true);

  return sessionDir;
};

export const listFiles = (sessionId, maxFiles = 200) => {
  const sessionDir = path.join(EXTRACT_ROOT, sessionId);
  if (!fs.existsSync(sessionDir)) return [];

  const results = [];
  const walk = (dir) => {
    if (results.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(path.relative(sessionDir, fullPath));
      }
      if (results.length >= maxFiles) return;
    }
  };
  walk(sessionDir);
  return results;
};

// Reads one file's content for the read_file tool. Path is relative to the
// session's extracted root — validated to prevent path traversal outside
// the session directory.
export const readSessionFile = (sessionId, relativePath) => {
  const sessionDir = path.join(EXTRACT_ROOT, sessionId);
  const target = path.resolve(sessionDir, relativePath);

  if (!target.startsWith(sessionDir)) {
    return { error: "Path outside session directory — not allowed." };
  }
  if (!fs.existsSync(target)) {
    return { error: `File not found: ${relativePath}` };
  }

  const content = fs.readFileSync(target, "utf-8");
  // Cap per-file size sent back to the model — avoid blowing the context
  // window on one huge file.
  const MAX_CHARS = 8000;
  return {
    content: content.length > MAX_CHARS
      ? content.slice(0, MAX_CHARS) + `\n\n[truncated — file is ${content.length} chars]`
      : content,
  };
};

export const cleanupSession = (sessionId) => {
  const sessionDir = path.join(EXTRACT_ROOT, sessionId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
};
