// The independent semantic judge: verdicts map to statuses, failures never pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePolicy, verifyRun, type Judge, type JudgeInput, type PolicyDocument } from "@agentproof/core";
import { createVerifier } from "@agentproof/sdk";
import { deliverable, POLICY } from "./helpers.ts";

const withSemantics = (extra: Record<string, unknown> = {}) =>
  compilePolicy({
    ...(POLICY.document as PolicyDocument),
    mode: "enforce",
    checks: { ...POLICY.document.checks, semantics: { enabled: true, timeout_ms: 200, ...extra } },
  });

const answer = { text: "Offline sync is GA.", claims: deliverable.output.claims };
const judgeOf = (fn: (input: JudgeInput, signal: AbortSignal) => Promise<{ verdict: "supported" | "unsupported" | "unclear"; rationale?: string }>): Judge => ({
  id: "fake:judge/v1",
  assess: fn,
});

async function run(judge: Judge, policy = withSemantics()) {
  const proof = await createVerifier({ policy, judge, store: false });
  return proof.verifyAnswer({ output: answer, evidence: deliverable.evidence });
}

describe("semantic judge", () => {
  it("supported → pass, recorded as a model assessment", async () => {
    const r = await run(judgeOf(async () => ({ verdict: "supported" })));
    const result = r.checks.find((c) => c.check === "claims.support")!;
    assert.equal(r.decision, "allow");
    assert.equal(result.kind, "probabilistic");
    assert.match(result.message, /Model assessment \(fake:judge\/v1 · excerpt [0-9a-f]{12}\)/);
  });

  it("unsupported → block", async () => {
    const r = await run(judgeOf(async () => ({ verdict: "unsupported", rationale: "The excerpt is about beta status." })));
    assert.equal(r.decision, "block");
    assert.deepEqual(r.reason_codes, ["CLAIM_UNSUPPORTED"]);
  });

  it("unclear → review", async () => {
    const r = await run(judgeOf(async () => ({ verdict: "unclear" })));
    assert.equal(r.decision, "review");
    assert.deepEqual(r.reason_codes, ["CLAIM_SUPPORT_UNCLEAR"]);
  });

  it("a timeout or a throwing judge → review, never pass", async () => {
    const slow = await run(judgeOf((_, signal) => new Promise((resolve) => setTimeout(() => resolve({ verdict: "supported" }), 5_000).unref())));
    assert.equal(slow.decision, "review");
    assert.deepEqual(slow.reason_codes, ["JUDGE_UNAVAILABLE"]);
    const broken = await run(judgeOf(async () => { throw new Error("rate limited"); }));
    assert.equal(broken.decision, "review");
  });

  it("sees only the claim and a grounded excerpt — nothing else from the run", async () => {
    const seen: JudgeInput[] = [];
    await run(judgeOf(async (input) => (seen.push(input), { verdict: "supported" })));
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]!).sort(), ["claim", "excerpt"]);
    assert.match(seen[0]!.excerpt, /Offline sync is now generally available\./);
  });

  it("does not judge claims whose quote isn't grounded", async () => {
    let calls = 0;
    const proof = await createVerifier({ policy: withSemantics(), judge: judgeOf(async () => (calls++, { verdict: "supported" })), store: false });
    const fabricated = { text: "x", claims: [{ id: "c1", text: "Sync launched in June.", quote: "Sync launched in June 2026.", evidence_ids: ["d1"] }] };
    const r = await proof.verifyAnswer({ output: fabricated, evidence: deliverable.evidence });
    assert.equal(calls, 0);
    assert.ok(r.reason_codes.includes("QUOTE_NOT_FOUND"));
  });

  it("can be advisory: shown, never decides", async () => {
    const policy = compilePolicy({
      ...(POLICY.document as PolicyDocument),
      mode: "enforce",
      checks: { ...POLICY.document.checks, semantics: { enabled: true } },
      enforcement: { ...POLICY.document.enforcement, advisory_checks: ["evidence.freshness", "claims.support"] },
    });
    const r = await run(judgeOf(async () => ({ verdict: "unsupported" })), policy);
    assert.equal(r.decision, "allow");
  });

  it("refuses to start without a judge when the policy enables semantics", async () => {
    await assert.rejects(createVerifier({ policy: withSemantics(), store: false }), /no judge was configured/);
  });

  it("a replay without a judge is inconclusive, not silently passed", () => {
    const r = verifyRun({ api_version: "agentproof/v1", run_id: "x", boundary: "final_answer", output: answer, evidence: deliverable.evidence }, { policy: withSemantics() });
    assert.equal(r.evaluated_decision, "review");
    assert.deepEqual(r.reason_codes, ["JUDGE_UNAVAILABLE"]);
  });
});
