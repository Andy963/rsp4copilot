const test = require("node:test");
const assert = require("node:assert/strict");

const { responsesReqVariants } = require("../dist/test/providers/openai/responses_variants");

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

test("responsesReqVariants does not rewrite instructions by default", () => {
  const req = {
    model: "gpt-test",
    instructions: "You are a helpful assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };

  const variants = responsesReqVariants(req, false);
  assert.ok(Array.isArray(variants));
  assert.ok(variants.length > 0);

  for (const v of variants) {
    assert.equal(hasOwn(v, "instructions"), true);
    assert.equal(v.instructions, req.instructions);
  }
});

test("responsesReqVariants rewrites instructions only when enabled (non-anchored)", () => {
  const req = {
    model: "gpt-test",
    instructions: "You are a helpful assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };

  const variants = responsesReqVariants(req, false, { rewriteInstructions: true });
  assert.ok(Array.isArray(variants));
  assert.ok(variants.length > 0);

  const hasSystemRewrite = variants.some((v) => {
    if (!v || typeof v !== "object") return false;
    if (hasOwn(v, "instructions")) return false;
    if (!Array.isArray(v.input) || v.input.length < 1) return false;
    const first = v.input[0];
    if (!first || typeof first !== "object") return false;
    if (first.role !== "system") return false;
    const content = first.content;
    if (typeof content === "string") return String(content).includes(req.instructions);
    if (Array.isArray(content)) return JSON.stringify(content).includes(req.instructions);
    return false;
  });
  assert.equal(hasSystemRewrite, true);

  const hasPromptRewrite = variants.some((v) => {
    if (!v || typeof v !== "object") return false;
    if (hasOwn(v, "instructions")) return false;
    if (!Array.isArray(v.input) || v.input.length !== 1) return false;
    const only = v.input[0];
    if (!only || typeof only !== "object") return false;
    if (only.role !== "user") return false;
    const parts = only.content;
    if (!Array.isArray(parts) || parts.length < 1) return false;
    const t = parts[0]?.text;
    return typeof t === "string" && t.includes(req.instructions) && t.includes("user:");
  });
  assert.equal(hasPromptRewrite, true);
});

test("responsesReqVariants preserves explicit instructions for anchored requests", () => {
  const cases = [
    { name: "previous_response_id + string", anchor: { previous_response_id: "resp_1" }, instructions: "Do the thing." },
    { name: "conversation + null", anchor: { conversation: "conv_1" }, instructions: null },
    { name: "previous_response_id + empty", anchor: { previous_response_id: "resp_2" }, instructions: "" },
  ];

  for (const tc of cases) {
    const req = {
      model: "gpt-test",
      ...tc.anchor,
      instructions: tc.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };

    const variants = responsesReqVariants(req, false, { rewriteInstructions: true });
    assert.ok(Array.isArray(variants), tc.name);
    assert.ok(variants.length > 0, tc.name);

    for (const v of variants) {
      assert.equal(hasOwn(v, "instructions"), true, tc.name);
      assert.equal(v.instructions, tc.instructions, tc.name);
    }
  }
});
