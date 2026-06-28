/**
 * sessionStore.js
 * Manages interview state between HTTP requests using Redis.
 * Sessions expire after 30 min of inactivity.
 */

import { getRedis } from "../cache/redis.js";

const SESSION_TTL = 60 * 30; // 30 minutes

export const createSession = async (sessionId, rawIntent) => {
  const session = {
    sessionId,
    rawIntent,
    history:                [],
    turnCount:              0,
    status:                 "interviewing",
    structuredContext:      null,
    interviewerTokensUsed:  0,
    createdAt:              Date.now(),
  };
  await saveSession(sessionId, session);
  return session;
};

export const getSession = async (sessionId) => {
  const redis = getRedis();
  const raw   = await redis.get(`po:session:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
};

export const saveSession = async (sessionId, session) => {
  const redis = getRedis();
  await redis.setex(`po:session:${sessionId}`, SESSION_TTL, JSON.stringify(session));
};

export const isMaxTurnsReached = (session) =>
  session.turnCount >= (parseInt(process.env.MAX_TURNS ?? "4", 10));