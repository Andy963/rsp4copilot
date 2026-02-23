const test = require("node:test");
const assert = require("node:assert/strict");

const { geminiRequestToOpenAIChat, openAIChatResponseToGemini } = require("../../dist/test/protocols/gemini");

test("geminiRequestToOpenAIChat maps system, contents, tools, and generationConfig", () => {
  const out = geminiRequestToOpenAIChat({
    systemInstruction: { parts: [{ text: "sys1" }, { text: "sys2" }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "hi" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      },
      { role: "model", parts: [{ text: "hello" }] },
    ],
    tools: [
      {
        functionDeclarations: [
          { name: "getWeather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 77, temperature: 0.5, topP: 0.9 },
  });

  assert.equal(out.model, "");
  assert.equal(out.stream, false);
  assert.equal(out.max_tokens, 77);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.top_p, 0.9);

  assert.ok(Array.isArray(out.messages));
  assert.deepEqual(out.messages[0], { role: "system", content: "sys1sys2" });

  assert.equal(out.messages[1].role, "user");
  assert.ok(Array.isArray(out.messages[1].content));
  assert.equal(out.messages[1].content[0].type, "text");
  assert.equal(out.messages[1].content[0].text, "hi");
  assert.equal(out.messages[1].content[1].type, "image_url");
  assert.equal(out.messages[1].content[1].image_url.url, "data:image/png;base64,aGVsbG8=");

  assert.deepEqual(out.messages[2], { role: "assistant", content: [{ type: "text", text: "hello" }] });

  assert.ok(Array.isArray(out.tools));
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "getWeather");
});

test("openAIChatResponseToGemini maps response fields", () => {
  const out = openAIChatResponseToGemini({
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });

  assert.ok(Array.isArray(out.candidates));
  assert.equal(out.candidates[0].content.role, "model");
  assert.equal(out.candidates[0].content.parts[0].text, "hi");
  assert.equal(out.candidates[0].finishReason, "stop");

  assert.equal(out.usageMetadata.promptTokenCount, 1);
  assert.equal(out.usageMetadata.candidatesTokenCount, 2);
  assert.equal(out.usageMetadata.totalTokenCount, 3);
});
