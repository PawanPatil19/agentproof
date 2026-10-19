// Acceptance A06 / A08: receipts are inspectable, metadata-only by default, and reports are inert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { compilePolicy, parsePolicy, renderReport, verifyReceiptDigest, verifyRun, type PolicyDocument } from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, fixtures), "utf8");
const policyText = read("agentproof.yaml");
const policy = parsePolicy(policyText);
const run = (name: string) => JSON.parse(read(`runs/${name}.json`));

describe("receipts", () => {
  it("carry ids, versions, digests, coverage and per-check reasons", () => {
    const r = verifyRun(run("missing-evidence-id"), { policy });
    assert.equal(r.receipt_version, "agentproof.receipt/v1");
    assert.equal(r.run_id, "fx-missing-evidence-id");
    assert.equal(r.task_id, "task-42");
    assert.equal(r.policy.id, "research-handoff");
    assert.match(r.policy.digest, /^sha256:/);
    assert.equal(r.contract?.attempt, 1);
    assert.equal(r.coverage.claims_total, 3);
    assert.equal(r.coverage.claims_passing, 2);
    assert.ok(r.checks.every((c) => c.kind === "deterministic" && c.message.length > 0));
    assert.ok(verifyReceiptDigest(r));
  });

  it("never contain evidence bodies, claim text, query strings or secrets by default", () => {
    const input = run("secret-in-claim");
    const json = JSON.stringify(verifyRun(input, { policy }));
    assert.doesNotMatch(json, /sk-live_/);
    assert.doesNotMatch(json, /Offline sync is generally available/);
    assert.doesNotMatch(json, /Pricing for the Pro plan/);
    assert.doesNotMatch(json, /session=abc123/);
  });

  it("include redacted claim text only when privacy.capture is 'claims'", () => {
    const doc = { ...(policy.document as PolicyDocument), privacy: { capture: "claims" as const } };
    const r = verifyRun(run("secret-in-claim"), { policy: compilePolicy(doc) });
    assert.match(r.claims[0]!.text ?? "", /Offline sync is generally available/);
    assert.doesNotMatch(r.claims[0]!.text ?? "", /sk-live_/);
  });

  it("detect edits after sealing", () => {
    const r = verifyRun(run("valid"), { policy });
    assert.equal(verifyReceiptDigest({ ...r, decision: "block" }), false);
  });

  it("keep a crashing check from reading as a pass", () => {
    const broken = run("valid");
    // A getter that throws simulates a checker bug or hostile input.
    Object.defineProperty(broken.evidence[0], "locator", { get() { throw new Error("boom"); }, enumerable: true });
    const r = verifyRun(broken, { policy, mode: "enforce" });
    assert.ok(r.checks.some((c) => c.reason === "CHECKER_ERROR" && c.status === "unknown"));
    assert.equal(r.decision, "block");
  });
});

describe("html report", () => {
  it("escapes captured text and never links unsafe locators", () => {
    const input = run("unsafe-locator");
    input.output.claims[0].text = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const receipt = verifyRun(input, { policy });
    const html = renderReport(receipt, { claimText: new Map([["c1", { text: input.output.claims[0].text }]]) });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.match(html, /Content-Security-Policy/);
  });

  it("explains observe-mode outcomes as would-be decisions", () => {
    const html = renderReport(verifyRun(run("fabricated-quote"), { policy, mode: "observe" }));
    assert.match(html, /Would block — observe mode/);
    assert.match(html, /QUOTE_NOT_FOUND/);
  });
});
