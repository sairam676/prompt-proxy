/**
 * redis.js
 * Two roles:
 *   1. Response cache  — keyed by context hash, TTL 24h
 *   2. Analytics store — HINCRBY token counts per session
 */

import Redis  from "ioredis";
import crypto from "crypto";

let client = null;

export const connectRedis = () => {
  if (client) return client;
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
    connectTimeout: 10000,
  });
  client.on("connect", () => console.log("[Redis] Connected"));
  client.on("error",   (e) => console.error("[Redis] Error:", e.message));
  return client;
};

export const getRedis = () => {
  if (!client) throw new Error("Redis not initialised — call connectRedis() first");
  return client;
};

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Deterministic hash of structured context.
 * Sort keys first so field order doesn't matter.
 */
export const hashContext = (ctx) => {
  const sorted = JSON.stringify(ctx, Object.keys(ctx).sort());
  return crypto.createHash("sha256").update(sorted).digest("hex").slice(0, 32);
};

// ── Response cache ─────────────────────────────────────────────────────────────

const CACHE_TTL = parseInt(process.env.CACHE_TTL ?? "86400", 10); // 24h default

export const cacheSet = async (hash, payload) => {
  const redis = getRedis();
  await redis.setex(
    `po:response:${hash}`,
    CACHE_TTL,
    JSON.stringify({ ...payload, cachedAt: Date.now() })
  );
};

export const cacheGet = async (hash) => {
  const redis = getRedis();
  const raw   = await redis.get(`po:response:${hash}`);
  return raw ? JSON.parse(raw) : null;
};

// ── Analytics ─────────────────────────────────────────────────────────────────

export const logAnalytics = async (sessionId, { tokensSaved, tokensUsed, cacheHit }) => {
  const redis = getRedis();
  const key   = `po:analytics:${sessionId}`;
  await redis.hincrby(key, "tokensSaved",   tokensSaved);
  await redis.hincrby(key, "tokensUsed",    tokensUsed);
  await redis.hincrby(key, "cacheHits",     cacheHit ? 1 : 0);
  await redis.hincrby(key, "totalRequests", 1);
  await redis.expire(key, 60 * 60 * 24 * 7); // 7 days
};

export const getAnalytics = async (sessionId) => {
  const redis = getRedis();
  return redis.hgetall(`po:analytics:${sessionId}`);
};