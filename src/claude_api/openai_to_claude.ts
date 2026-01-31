export function openaiFinishReasonToClaude(stopReason: unknown): string {
  if (stopReason === "tool_calls") return "tool_use";
  if (stopReason === "length") return "max_tokens";
  if (stopReason === "stop") return "end_turn";
  return "end_turn";
}

