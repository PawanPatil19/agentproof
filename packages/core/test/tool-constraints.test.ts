// Argument constraints: what a worker may do *with* a tool, checked purely.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePolicy, contractInstanceDigest, evaluateToolCall, PolicyError, usageOf, verifyRun, type ContractInstance, type ToolConstraint, type ToolEvent } from "@agentproof/core";

const policyWith = (constraint: ToolConstraint, allowed = ["payments.send"]) =>
  compilePolicy({
    api_version: "agentproof/v1",
    policy: { id: "p", version: 1 },
    contracts: { pay: { version: 1, coordinator: "a", worker: "b", deadline_ms: 1000, allowed_tools: allowed, tool_constraints: { "payments.send": constraint } } },
  });
const contractWith = (constraint: ToolConstraint) => policyWith(constraint).contracts.get("pay")!;
const none = { calls: 0, total: 0 };

describe("tool_constraints in the policy", () => {
  it("rejects constraints the guard could never apply or that contradict themselves", () => {
    const issues = (c: ToolConstraint, allowed?: string[]) => {
      try {
        policyWith(c, allowed);
        return [];
      } catch (e) {
        return (e as PolicyError).issues.map((i) => i.message);
      }
    };
    assert.match(issues({ max_calls: 1 }, ["docs.read"]).join(), /not in allowed_tools/);
    assert.match(issues({ max_total: 10 }).join(), /need amount_field/);
    assert.match(issues({ window_ms: 1000 }).join(), /window_ms only applies/);
    assert.match(issues({ amount_field: "amount", max_per_call: 100, max_total: 50 }).join(), /larger than max_total/);
    assert.ok(issues({ args_schema: { type: "nonsense" } }).length > 0);
    assert.throws(() => policyWith({ max_calls: 0 }), PolicyError);
    assert.throws(() => policyWith({ amount_field: "a..b" }), PolicyError);
    assert.throws(() => policyWith({ unknown_key: 1 } as ToolConstraint), PolicyError);
    assert.deepEqual(issues({ amount_field: "amount", max_total: 10 }, ["*"]), []);
  });

  it("constraints are part of the pinned definition digest", () => {
    const a = contractWith({ max_calls: 1 }).definitionDigest;
    const b = contractWith({ max_calls: 2 }).definitionDigest;
    assert.notEqual(a, b);
  });
});

describe("evaluateToolCall", () => {
  it("passes tools without constraints and checks args_schema", () => {
    const c = contractWith({ args_schema: { type: "object", required: ["to"], properties: { to: { type: "string" } } } });
    assert.equal(evaluateToolCall(c, "docs.read", { anything: 1 }, none).ok, true);
    assert.equal(evaluateToolCall(c, "payments.send", { to: "m1" }, none).ok, true);
    const bad = evaluateToolCall(c, "payments.send", { to: 5 }, none);
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.reason, "TOOL_ARGS_INVALID");
  });

  it("allowed_values reads dotted paths, fails closed on missing fields and never echoes values", () => {
    const c = contractWith({ allowed_values: { currency: ["SGD", "USDC"], "payee.id": ["merchant-a"] } });
    assert.equal(evaluateToolCall(c, "payments.send", { currency: "SGD", payee: { id: "merchant-a" } }, none).ok, true);
    const stranger = evaluateToolCall(c, "payments.send", { currency: "SGD", payee: { id: "secret-stranger" } }, none);
    assert.equal(!stranger.ok && stranger.reason, "TOOL_ARGS_INVALID");
    assert.doesNotMatch(!stranger.ok ? stranger.message : "", /secret-stranger/);
    assert.equal(evaluateToolCall(c, "payments.send", { currency: "SGD" }, none).ok, false);
    assert.equal(evaluateToolCall(c, "payments.send", { currency: "SGD", payee: Object.create({ id: "merchant-a" }) }, none).ok, false, "inherited properties do not count");
    assert.equal(evaluateToolCall(c, "payments.send", { currency: "sgd", payee: { id: "merchant-a" } }, none).ok, false, "comparison is exact");
  });

  it("meters amounts per call, in total and by call count", () => {
    const c = contractWith({ amount_field: "amount", max_per_call: 50, max_total: 120, max_calls: 3 });
    const ok = evaluateToolCall(c, "payments.send", { amount: 50 }, none);
    assert.deepEqual(ok, { ok: true, amount: 50, consumed: { calls: 1, total: 50 } });
    const over = evaluateToolCall(c, "payments.send", { amount: 50.01 }, none);
    assert.equal(!over.ok && over.reason, "TOOL_LIMIT_EXCEEDED");
    assert.equal(evaluateToolCall(c, "payments.send", { amount: 30 }, { calls: 2, total: 100 }).ok, false, "total 130 > 120");
    assert.equal(evaluateToolCall(c, "payments.send", { amount: 20 }, { calls: 2, total: 100 }).ok, true, "total exactly at the limit");
    assert.equal(evaluateToolCall(c, "payments.send", { amount: 1 }, { calls: 3, total: 3 }).ok, false, "fourth call");
  });

  it("rejects amounts that are missing, negative, non-numeric or not finite", () => {
    const c = contractWith({ amount_field: "amount", max_total: 100 });
    for (const amount of [undefined, -1, "10", Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = evaluateToolCall(c, "payments.send", { amount }, none);
      assert.equal(!v.ok && v.reason, "TOOL_ARGS_INVALID", String(amount));
    }
  });

  it("tolerates floating-point noise but not real overspend", () => {
    const c = contractWith({ amount_field: "amount", max_total: 0.3 });
    assert.equal(evaluateToolCall(c, "payments.send", { amount: 0.2 }, { calls: 1, total: 0.1 }).ok, true);
    assert.equal(evaluateToolCall(c, "payments.send", { amount: 0.21 }, { calls: 1, total: 0.1 }).ok, false);
  });
});

describe("usageOf", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const ev = (at: string | undefined, amount: number, outcome: ToolEvent["outcome"] = "invoked", tool = "payments.send"): ToolEvent => ({ tool, agent: "b", at, amount, outcome });

  it("counts calls that ran, ignores blocked ones and other tools", () => {
    const events = [ev("2026-10-19T11:00:00Z", 10), ev("2026-10-19T11:01:00Z", 99, "blocked"), ev("2026-10-19T11:02:00Z", 5, "invoked", "docs.read")];
    assert.deepEqual(usageOf(events, "payments.send", now), { calls: 1, total: 10 });
  });

  it("applies a rolling window; events without a time always count", () => {
    const events = [ev("2026-10-18T11:00:00Z", 10), ev("2026-10-19T11:30:00Z", 20), ev(undefined, 5)];
    assert.deepEqual(usageOf(events, "payments.send", now, 3_600_000), { calls: 2, total: 25 });
    assert.deepEqual(usageOf(events, "payments.send", now), { calls: 3, total: 35 });
  });
});

describe("tools.permission re-checks recorded usage", () => {
  const policy = policyWith({ amount_field: "amount", max_per_call: 50, max_total: 80, max_calls: 3 });
  const terms = {
    name: "pay", version: 1, definition_digest: policy.contracts.get("pay")!.definitionDigest, task_id: "t", attempt_id: "a1", attempt: 1,
    coordinator: "agent://a", worker: "agent://b", issued_at: "2026-10-19T10:00:00Z", deadline_at: "2026-10-19T11:00:00Z",
  };
  const digest = contractInstanceDigest(terms);
  const contract: ContractInstance = { ...terms, digest, acceptance: { identity: "agent://b", digest, at: "2026-10-19T10:00:01Z" } };
  const run = (events: ToolEvent[]) =>
    verifyRun(
      { api_version: "agentproof/v1", run_id: "r", task_id: "t", boundary: "worker_completion", output: { claims: [] }, evidence: [], contract, tool_events: events, submitted_at: "2026-10-19T10:30:00Z" },
      { policy, mode: "enforce" },
    );
  const ev = (amount?: number): ToolEvent => ({ tool: "payments.send", agent: "agent://b", at: "2026-10-19T10:10:00Z", outcome: "invoked", ...(amount === undefined ? {} : { amount }) });
  const codes = (events: ToolEvent[]) => run(events).checks.filter((c) => c.check === "tools.permission").map((c) => c.reason);

  it("an envelope without reason codes still fails when amounts break the limits", () => {
    assert.deepEqual(codes([ev(40)]), ["OK"]);
    assert.deepEqual(codes([ev(5000)]), ["TOOL_LIMIT_EXCEEDED"]);
    assert.deepEqual(codes([ev(40), ev(41)]), ["TOOL_LIMIT_EXCEEDED"]);
    assert.deepEqual(codes([ev(1), ev(1), ev(1), ev(1)]), ["TOOL_LIMIT_EXCEEDED"]);
    assert.deepEqual(codes([ev()]), ["TOOL_ARGS_INVALID"]);
    assert.deepEqual(codes([ev(40), { ...ev(5000), outcome: "blocked", reason_code: "TOOL_LIMIT_EXCEEDED" }]), ["TOOL_LIMIT_EXCEEDED"], "the blocked attempt still fails the check");
  });
});
