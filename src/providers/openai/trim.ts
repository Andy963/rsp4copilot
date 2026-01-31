import { normalizeResponsesCallId } from "./thought_signature_cache";

function safeJsonLen(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s.length : String(s ?? "").length;
  } catch {
    return String(value ?? "").length;
  }
}

export function trimOpenAIResponsesRequestToMaxChars(
  req: any,
  maxChars: any,
): {
  ok: true;
  trimmed: boolean;
  beforeLen: number;
  afterLen: number;
  droppedTurns: number;
  droppedSystem: number;
  droppedTail: number;
  truncatedInputChars: number;
  truncatedInstructionChars: number;
  droppedTools: boolean;
  droppedUnpairedToolCalls: number;
} | { ok: false; error: string; beforeLen: number } {
  const limit = Number.isInteger(maxChars) ? maxChars : Number.isFinite(maxChars) ? Math.trunc(maxChars) : 0;
  const beforeLen = safeJsonLen(req);
  if (!(limit > 0) || beforeLen <= limit) {
    return {
      ok: true,
      trimmed: false,
      beforeLen,
      afterLen: beforeLen,
      droppedTurns: 0,
      droppedSystem: 0,
      droppedTail: 0,
      truncatedInputChars: 0,
      truncatedInstructionChars: 0,
      droppedTools: false,
      droppedUnpairedToolCalls: 0,
    };
  }

  if (!req || typeof req !== "object") {
    return { ok: false, error: `Input exceeds RSP4COPILOT_MAX_INPUT_CHARS=${limit}; reduce prompt size or raise the limit`, beforeLen };
  }

  let trimmed = false;
  let droppedTurns = 0;
  let droppedSystem = 0;
  let droppedTail = 0;
  let truncatedInputChars = 0;
  let truncatedInstructionChars = 0;
  let droppedTools = false;
  let droppedUnpairedToolCalls = 0;

  const roleOf = (item: any) => (item && typeof item === "object" && typeof item.role === "string" ? item.role.trim().toLowerCase() : "");
  const isSystemRole = (role: string) => role === "system" || role === "developer";
  const inputItemTypeOf = (item: any) => (item && typeof item === "object" && typeof item.type === "string" ? item.type.trim() : "");
  const callIdOf = (item: any) => {
    if (!item || typeof item !== "object") return "";
    const v = item.call_id ?? item.callId ?? item.id;
    return normalizeResponsesCallId(typeof v === "string" ? v.trim() : "");
  };

  const sanitizeResponsesToolPairs = () => {
    if (!Array.isArray(req.input) || req.input.length === 0) return 0;

    const hasPrev = (typeof req.previous_response_id === "string" && req.previous_response_id.trim()) || (typeof req.conversation === "string" && req.conversation.trim()) || false;

    const callIdsWithCall = new Set();
    const callIdsWithOutput = new Set();
    let sawToolItem = false;
    for (const item of req.input) {
      const t = inputItemTypeOf(item);
      if (t === "function_call") {
        sawToolItem = true;
        const id = callIdOf(item);
        if (id) callIdsWithCall.add(id);
      }
      if (t === "function_call_output") {
        sawToolItem = true;
        const id = callIdOf(item);
        if (id) callIdsWithOutput.add(id);
      }
    }
    if (!sawToolItem) return 0;

    let removed = 0;
    const nextInput: any[] = [];
    for (const item of req.input) {
      const t = inputItemTypeOf(item);
      if (t === "function_call") {
        const id = callIdOf(item);
        if (id && callIdsWithOutput.has(id)) nextInput.push(item);
        else removed++;
        continue;
      }
      if (t === "function_call_output") {
        const id = callIdOf(item);
        // Tool outputs can be "output-only" if the request is anchored by previous_response_id/conversation.
        if (id && (callIdsWithCall.has(id) || hasPrev)) nextInput.push(item);
        else removed++;
        continue;
      }
      nextInput.push(item);
    }
    if (removed > 0) req.input = nextInput;
    return removed;
  };

  const truncateStringFieldToFit = (parentObj: any, key: string, maxLen: number) => {
    if (!parentObj || typeof parentObj !== "object") return 0;
    const raw = parentObj[key];
    if (typeof raw !== "string") return 0;

    // Keep the tail of the string (often contains the actual user question).
    let lo = 0;
    let hi = raw.length;
    const original = raw;

    // Fast path: try empty string first (if even this doesn't fit, caller must try other fields).
    parentObj[key] = "";
    if (safeJsonLen(req) > maxLen) {
      parentObj[key] = original;
      return 0;
    }

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      parentObj[key] = original.slice(-mid);
      if (safeJsonLen(req) <= maxLen) lo = mid;
      else hi = mid - 1;
    }

    parentObj[key] = original.slice(-lo);
    return original.length - lo;
  };

  const tryTrimInputWindow = () => {
    if (!Array.isArray(req.input) || req.input.length <= 1) return false;

    const input = req.input;

    const baseLen = safeJsonLen({ ...req, input: [] });
    if (baseLen > limit) return false;

    const lens = input.map((it: any) => safeJsonLen(it));
    const prefixSum = new Array(lens.length + 1);
    prefixSum[0] = 0;
    for (let i = 0; i < lens.length; i++) prefixSum[i + 1] = prefixSum[i] + lens[i];

    let systemPrefixEnd = 0;
    while (systemPrefixEnd < input.length && isSystemRole(roleOf(input[systemPrefixEnd]))) systemPrefixEnd++;

    const userIdxs: number[] = [];
    for (let i = systemPrefixEnd; i < input.length; i++) {
      if (roleOf(input[i]) === "user") userIdxs.push(i);
    }
    const lastUserIdx = userIdxs.length ? userIdxs[userIdxs.length - 1] : -1;

    let sysStart = 0;
    let restStart = systemPrefixEnd;
    let restEnd = input.length;

    const selectedCount = () => systemPrefixEnd - sysStart + (restEnd - restStart);
    const selectedLensSum = () => (prefixSum[systemPrefixEnd] - prefixSum[sysStart]) + (prefixSum[restEnd] - prefixSum[restStart]);
    const selectedLen = () => {
      const count = selectedCount();
      const commas = count > 1 ? count - 1 : 0;
      return baseLen + selectedLensSum() + commas;
    };

    const advanceRestStart = () => {
      if (restStart >= restEnd) return false;

      // Drop any prelude before the first user item.
      if (userIdxs.length && restStart < userIdxs[0]) {
        restStart = userIdxs[0];
        return true;
      }

      let next = -1;
      for (const u of userIdxs) {
        if (u > restStart) {
          next = u;
          break;
        }
      }

      // Refuse to drop the last user turn (must keep the latest user input).
      if (lastUserIdx >= 0 && (next < 0 || next > lastUserIdx)) return false;

      if (next >= 0) {
        restStart = next;
        return true;
      }

      // No user messages: drop everything.
      restStart = restEnd;
      return true;
    };

    const dropTailOnce = () => {
      if (restEnd <= restStart) return false;
      const mustKeep = lastUserIdx >= 0 ? lastUserIdx + 1 : restStart + 1;
      const minEnd = Math.max(restStart + 1, mustKeep);
      if (restEnd <= minEnd) return false;
      restEnd--;
      return true;
    };

    let changed = false;
    while (selectedLen() > limit) {
      if (advanceRestStart()) {
        droppedTurns++;
        changed = true;
        continue;
      }
      if (sysStart < systemPrefixEnd) {
        sysStart++;
        droppedSystem++;
        changed = true;
        continue;
      }
      if (dropTailOnce()) {
        droppedTail++;
        changed = true;
        continue;
      }
      break;
    }

    if (!changed) return false;
    req.input = [...input.slice(sysStart, systemPrefixEnd), ...input.slice(restStart, restEnd)];
    droppedUnpairedToolCalls += sanitizeResponsesToolPairs();
    return true;
  };

  const tryTruncateLargestInputText = () => {
    if (!Array.isArray(req.input)) return false;

    // Clone input tree before mutating any nested text fields (variants may share item object references).
    req.input = req.input.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const cloned = { ...item };
      if (Array.isArray(item.content)) {
        cloned.content = item.content.map((part: any) => (part && typeof part === "object" ? { ...part } : part));
      }
      if (item.function && typeof item.function === "object") {
        cloned.function = { ...item.function };
      }
      return cloned;
    });

    let best: { obj: any; key: string; len: number } | null = null;
    for (const item of req.input) {
      if (!item || typeof item !== "object") continue;
      const r = roleOf(item);
      const t = inputItemTypeOf(item);
      if (r && r !== "user" && r !== "system" && r !== "developer") {
        // Non-message items can still contain huge strings (e.g., tool outputs).
        if (t !== "function_call" && t !== "function_call_output") continue;
      }

      const content = item.content;
      if (typeof content === "string") {
        if (!best || content.length > best.len) best = { obj: item, key: "content", len: content.length };
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          if (typeof part.text === "string") {
            const t = part.text;
            if (!best || t.length > best.len) best = { obj: part, key: "text", len: t.length };
          }
        }
      }

      if (t === "function_call") {
        if (typeof item.arguments === "string") {
          const a = item.arguments;
          if (!best || a.length > best.len) best = { obj: item, key: "arguments", len: a.length };
        }
        if (item.function && typeof item.function === "object" && typeof item.function.arguments === "string") {
          const a = item.function.arguments;
          if (!best || a.length > best.len) best = { obj: item.function, key: "arguments", len: a.length };
        }
      }
      if (t === "function_call_output") {
        if (typeof item.output === "string") {
          const o = item.output;
          if (!best || o.length > best.len) best = { obj: item, key: "output", len: o.length };
        }
      }
    }

    if (!best || best.len <= 0) return false;
    const cut = truncateStringFieldToFit(best.obj, best.key, limit);
    if (cut <= 0) return false;
    truncatedInputChars += cut;
    return true;
  };

  const tryTruncateInstructions = () => {
    if (typeof req.instructions !== "string" || !req.instructions) return false;
    const cut = truncateStringFieldToFit(req, "instructions", limit);
    if (cut <= 0) return false;
    truncatedInstructionChars += cut;
    return true;
  };

  const tryDropTools = () => {
    if (!("tools" in req)) return false;
    if (req.tools == null) return false;
    delete req.tools;
    droppedTools = true;
    return true;
  };

  // Iteratively shrink: drop old turns first, then truncate huge text fields, then drop tools as a last resort.
  let guard = 0;
  while (safeJsonLen(req) > limit && guard++ < 12) {
    if (tryTrimInputWindow()) {
      trimmed = true;
      continue;
    }
    if (tryTruncateLargestInputText()) {
      trimmed = true;
      continue;
    }
    if (tryTruncateInstructions()) {
      trimmed = true;
      continue;
    }
    if (tryDropTools()) {
      trimmed = true;
      continue;
    }
    break;
  }

  droppedUnpairedToolCalls += sanitizeResponsesToolPairs();

  const afterLen = safeJsonLen(req);
  if (afterLen > limit) {
    // Last resort: keep only a minimal request with the latest user input.
    let lastUser: any | null = null;
    const input = Array.isArray(req.input) ? req.input : [];
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item || typeof item !== "object") continue;
      if (roleOf(item) === "user") {
        lastUser = item;
        break;
      }
    }

    const modelValue = req.model;
    for (const k of Object.keys(req)) delete req[k];
    if (modelValue !== undefined) req.model = modelValue;
    req.input = lastUser ? [lastUser] : [];

    trimmed = true;
    droppedUnpairedToolCalls += sanitizeResponsesToolPairs();
    while (safeJsonLen(req) > limit && guard++ < 12) {
      if (tryTruncateLargestInputText()) {
        trimmed = true;
        continue;
      }
      if (tryTruncateInstructions()) {
        trimmed = true;
        continue;
      }
      break;
    }
  }

  const finalLen = safeJsonLen(req);
  return {
    ok: true,
    trimmed: trimmed || finalLen !== beforeLen,
    beforeLen,
    afterLen: finalLen,
    droppedTurns,
    droppedSystem,
    droppedTail,
    truncatedInputChars,
    truncatedInstructionChars,
    droppedTools,
    droppedUnpairedToolCalls,
  };
}

export function sanitizeResponsesToolItemsForUpstream(req: any): { normalizedCallIds: number; droppedToolOutputs: number } {
  // Defensive: some clients accidentally send `function_call_output` on the first turn
  // (no `previous_response_id` and no in-request `function_call`), which upstream rejects:
  // "No tool call found for function call output with call_id ...".
  if (!req || typeof req !== "object") return { normalizedCallIds: 0, droppedToolOutputs: 0 };
  if (!Array.isArray(req.input)) return { normalizedCallIds: 0, droppedToolOutputs: 0 };

  const input = req.input as any[];
  if (!input.length) return { normalizedCallIds: 0, droppedToolOutputs: 0 };

  const prevIdRaw = req.previous_response_id;
  const hasPrevId = typeof prevIdRaw === "string" && prevIdRaw.trim();

  let normalizedCallIds = 0;
  const callIdsWithCall = new Set<string>();

  // Normalize call ids for tool items and collect in-request function calls.
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const t = item.type;
    if (t !== "function_call" && t !== "function_call_output") continue;
    const callId = normalizeResponsesCallId(item.call_id ?? item.callId ?? item.id);
    if (!callId) continue;

    // Some clients send only `id:"fc_<callId>"` and omit `call_id`; make it explicit for upstream.
    if (typeof item.call_id !== "string" || item.call_id.trim() !== callId) {
      item.call_id = callId;
      normalizedCallIds++;
    }
    if (t === "function_call") callIdsWithCall.add(callId);
  }

  let droppedToolOutputs = 0;
  if (!hasPrevId) {
    const next: any[] = [];
    for (const item of input) {
      if (!item || typeof item !== "object" || item.type !== "function_call_output") {
        next.push(item);
        continue;
      }
      const callId = normalizeResponsesCallId(item.call_id ?? item.callId ?? item.id);
      // Without previous_response_id, tool outputs must correspond to a tool call present in the same request.
      if (!callId || !callIdsWithCall.has(callId)) {
        droppedToolOutputs++;
        continue;
      }
      next.push(item);
    }
    if (droppedToolOutputs > 0) req.input = next;
  }

  return { normalizedCallIds, droppedToolOutputs };
}

