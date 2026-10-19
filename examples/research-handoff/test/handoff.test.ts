// End-to-end: the two-agent sample blocks bad handoffs before anything downstream sees them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHandoff } from "../src/workflow.ts";

describe("research → writer handoff", () => {
  it("releases an honest deliverable after two passing gates", async () => {
    const r = await runHandoff({ personality: "honest" });
    assert.equal(r.outcome, "released");
    assert.deepEqual(r.receipts.map((x) => x.boundary), ["worker_completion", "final_answer"]);
    assert.match(r.answer ?? "", /Lumen Notes 3.2/);
  });

  it("blocks a missing-evidence handoff, then accepts one bounded repair", async () => {
    const r = await runHandoff({ personality: "sloppy" });
    assert.equal(r.outcome, "released");
    assert.deepEqual(r.receipts[0]!.reason_codes, ["EVIDENCE_UNKNOWN_ID"]);
    assert.equal(r.receipts[1]!.contract?.attempt, 2);
    assert.equal(r.receipts[1]!.contract?.parent_attempt_id, r.receipts[0]!.contract?.attempt_id);
  });

  it("blocks a fabricated quote", async () => {
    const r = await runHandoff({ personality: "fabricating" });
    assert.deepEqual(r.receipts[0]!.reason_codes, ["QUOTE_NOT_FOUND"]);
  });

  it("enforce: the publish tool never runs and the task stops", async () => {
    const r = await runHandoff({ personality: "overreaching" });
    assert.equal(r.outcome, "blocked");
    assert.equal(r.published.length, 0);
    assert.equal(r.receipts.length, 1, "no final answer is produced");
  });

  it("observe: the same run continues and records the would-be block", async () => {
    const r = await runHandoff({ personality: "overreaching", mode: "observe" });
    assert.equal(r.published.length, 1);
    assert.equal(r.receipts[0]!.evaluated_decision, "block");
    assert.equal(r.receipts[0]!.decision, "allow");
  });
});
