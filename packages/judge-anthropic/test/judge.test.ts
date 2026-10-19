// The reference judge, against a stub client: request shape and response handling.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicJudge, PROMPT_VERSION } from "../src/index.ts";

type Captured = { params: Record<string, any>; options: Record<string, any> };

function stub(reply: Record<string, unknown>) {
  const calls: Captured[] = [];
  const client = {
    beta: { messages: { create: async (params: Record<string, any>, options: Record<string, any>) => (calls.push({ params, options }), reply) } },
  };
  return { client: client as never, calls };
}

const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
const input = { claim: "Offline sync is GA.", excerpt: "Offline sync is now generally available." };

describe("anthropicJudge", () => {
  it("sends one fresh request: only claim and excerpt, no tools, structured output", async () => {
    const { client, calls } = stub(text(JSON.stringify({ verdict: "supported", rationale: "Stated directly." })));
    const judge = anthropicJudge({ client });
    const result = await judge.assess(input, new AbortController().signal);

    assert.deepEqual(result, { verdict: "supported", rationale: "Stated directly." });
    assert.equal(judge.id, `anthropic:claude-opus-5-5/${PROMPT_VERSION}`);
    const { params, options } = calls[0]!;
    assert.equal(params.model, "claude-opus-5-5");
    assert.equal(params.tools, undefined);
    assert.equal(params.messages.length, 1);
    assert.match(params.messages[0].content, /<claim>\nOffline sync is GA\.\n<\/claim>/);
    assert.equal(params.output_config.format.type, "json_schema");
    assert.equal(params.fallbacks, "default");
    assert.ok(options.signal instanceof AbortSignal);
  });

  it("treats refusals, bad JSON and unknown verdicts as unclear", async () => {
    for (const reply of [
      { stop_reason: "refusal", content: [] },
      text("not json"),
      text(JSON.stringify({ verdict: "probably", rationale: "x" })),
    ]) {
      const result = await anthropicJudge({ client: stub(reply).client }).assess(input, new AbortController().signal);
      assert.equal(result.verdict, "unclear");
    }
  });

  it("honours model, effort and fallback options", async () => {
    const { client, calls } = stub(text(JSON.stringify({ verdict: "unsupported", rationale: "No date in excerpt." })));
    await anthropicJudge({ client, model: "claude-sonnet-5-5", effort: "low", fallbacks: false }).assess(input, new AbortController().signal);
    assert.equal(calls[0]!.params.model, "claude-sonnet-5-5");
    assert.equal(calls[0]!.params.output_config.effort, "low");
    assert.equal(calls[0]!.params.fallbacks, undefined);
  });
});
