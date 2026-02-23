const test = require("node:test");
const assert = require("node:assert/strict");

const { responsesRequestToOpenAIChat, openAIChatResponseToResponses } = require("../../dist/test/protocols/responses");

test("responsesRequestToOpenAIChat converts tool calls and tool outputs", () => {
  const out = responsesRequestToOpenAIChat({
    model: "gpt-test",
    instructions: "You are a helpful assistant.",
    tools: [{ type: "function", name: "getWeather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    tool_choice: { type: "function", name: "getWeather" },
    max_output_tokens: 123,
    temperature: 0.7,
    top_p: 0.9,
    stream: true,
    input: [
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "getWeather", arguments: { city: "Seattle" }, thought_signature: "sig_1", thought: "think_1" },
      { type: "function_call_output", call_id: "fc_call_1", output: "sunny" },
    ],
  });

  assert.equal(out.model, "gpt-test");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 123);
  assert.equal(out.temperature, 0.7);
  assert.equal(out.top_p, 0.9);

  assert.ok(Array.isArray(out.messages));
  assert.deepEqual(out.messages[0], { role: "system", content: "You are a helpful assistant." });
  assert.deepEqual(out.messages[1], { role: "user", content: "hi" });

  assert.equal(out.messages[2].role, "assistant");
  assert.equal(out.messages[2].content, null);
  assert.ok(Array.isArray(out.messages[2].tool_calls));
  assert.equal(out.messages[2].tool_calls[0].id, "call_1");
  assert.equal(out.messages[2].tool_calls[0].type, "function");
  assert.equal(out.messages[2].tool_calls[0].function.name, "getWeather");
  assert.equal(out.messages[2].tool_calls[0].function.arguments, "{\"city\":\"Seattle\"}");
  assert.equal(out.messages[2].tool_calls[0].thought_signature, "sig_1");
  assert.equal(out.messages[2].tool_calls[0].thought, "think_1");

  assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "call_1", content: "sunny" });

  assert.ok(Array.isArray(out.tools));
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "getWeather");
  assert.equal(out.tool_choice.type, "function");
  assert.equal(out.tool_choice.function.name, "getWeather");
});

test("openAIChatResponseToResponses emits message, reasoning, and function_call items", () => {
  const out = openAIChatResponseToResponses(
    {
      id: "chatcmpl_123",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello!",
            reasoning_content: "Because.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "getWeather", arguments: "{\"city\":\"Seattle\"}" },
                thought_signature: "sig_1",
                thought: "think_1",
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
    "gpt-test",
  );

  assert.equal(out.id, "resp_123");
  assert.equal(out.object, "response");
  assert.equal(out.model, "gpt-test");
  assert.equal(out.status, "completed");
  assert.equal(out.output_text, "Hello!");

  assert.ok(Array.isArray(out.output));
  const reasoning = out.output.find((i) => i && typeof i === "object" && i.type === "reasoning");
  assert.ok(reasoning);
  assert.equal(reasoning.status, "completed");
  assert.equal(reasoning.content[0].type, "reasoning_text");
  assert.equal(reasoning.content[0].text, "Because.");

  const msg = out.output.find((i) => i && typeof i === "object" && i.type === "message");
  assert.ok(msg);
  assert.equal(msg.role, "assistant");
  assert.equal(msg.status, "completed");
  assert.equal(msg.content[0].type, "output_text");
  assert.equal(msg.content[0].text, "Hello!");

  const fc = out.output.find((i) => i && typeof i === "object" && i.type === "function_call");
  assert.ok(fc);
  assert.equal(fc.call_id, "call_1");
  assert.equal(fc.id, "fc_call_1");
  assert.equal(fc.name, "getWeather");
  assert.equal(fc.arguments, "{\"city\":\"Seattle\"}");
  assert.equal(fc.thought_signature, "sig_1");
  assert.equal(fc.thought, "think_1");
});
