import type { Env } from "./types";

export const DEFAULT_RSP4COPILOT_MAX_TURNS = 40;
export const DEFAULT_RSP4COPILOT_MAX_MESSAGES = 200;
export const DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS = 300000;
export const DEFAULT_RESP_MAX_BUFFERED_SSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RESP_EMPTY_SSE_DETECT_TIMEOUT_MS = 150;

function parseIntEnv(raw: unknown, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function getRsp4CopilotLimits(env: Env): { maxTurns: number; maxMessages: number; maxInputChars: number } {
  const defaultMaxInputChars = parseIntEnv(env?.DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS, DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS);
  return {
    maxTurns: parseIntEnv(env?.RSP4COPILOT_MAX_TURNS, DEFAULT_RSP4COPILOT_MAX_TURNS),
    maxMessages: parseIntEnv(env?.RSP4COPILOT_MAX_MESSAGES, DEFAULT_RSP4COPILOT_MAX_MESSAGES),
    maxInputChars: parseIntEnv(env?.RSP4COPILOT_MAX_INPUT_CHARS, defaultMaxInputChars),
  };
}

export function getRsp4CopilotStreamLimits(env: Env): { maxBufferedSseBytes: number; emptySseDetectTimeoutMs: number } {
  return {
    maxBufferedSseBytes: parseIntEnv(env?.RESP_MAX_BUFFERED_SSE_BYTES, DEFAULT_RESP_MAX_BUFFERED_SSE_BYTES),
    emptySseDetectTimeoutMs: parseIntEnv(env?.RESP_EMPTY_SSE_DETECT_TIMEOUT_MS, DEFAULT_RESP_EMPTY_SSE_DETECT_TIMEOUT_MS),
  };
}
