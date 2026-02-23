const test = require("node:test");
const assert = require("node:assert/strict");

const { claudeMessagesRequestToOpenaiChat, openaiChatResponseToClaudeMessage } = require("../../dist/test/claude_api");

test("claudeMessagesRequestToOpenaiChat converts tool_use/tool_result blocks", () => {
  const res = claudeMessagesRequestToOpenaiChat({
    model: "claude-test",
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "toolu_1", name: "getWeather", input: { city: "Seattle" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }] },
    ],
    tools: [{ name: "getWeather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    tool_choice: { type: "tool", name: "getWeather" },
    max_tokens: 100,
    stream: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.req.model, "claude-test");
  assert.equal(res.req.stream, false);
  assert.equal(res.req.max_tokens, 100);
  assert.equal(res.req.tool_choice.type, "function");
  assert.equal(res.req.tool_choice.function.name, "getWeather");

  assert.ok(Array.isArray(res.req.messages));
  assert.deepEqual(res.req.messages[0], { role: "system", content: "You are a helpful assistant." });
  assert.deepEqual(res.req.messages[1], { role: "user", content: [{ type: "text", text: "hi" }] });

  assert.equal(res.req.messages[2].role, "assistant");
  assert.deepEqual(res.req.messages[2].content, [{ type: "text", text: "ok" }]);
  assert.ok(Array.isArray(res.req.messages[2].tool_calls));
  assert.equal(res.req.messages[2].tool_calls[0].id, "toolu_1");
  assert.equal(res.req.messages[2].tool_calls[0].function.name, "getWeather");
  assert.equal(res.req.messages[2].tool_calls[0].function.arguments, "{\"city\":\"Seattle\"}");

  assert.deepEqual(res.req.messages[3], { role: "tool", tool_call_id: "toolu_1", content: "sunny" });
});

test("openaiChatResponseToClaudeMessage maps finish_reason and content", () => {
  const out = openaiChatResponseToClaudeMessage({
    id: "chatcmpl_1",
    model: "gpt-test",
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });

  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, "gpt-test");
  assert.deepEqual(out.content, [{ type: "text", text: "hi" }]);
  assert.equal(out.stop_reason, "end_turn");
});
