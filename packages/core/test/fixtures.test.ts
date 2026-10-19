// Acceptance A02: every reviewed fixture produces its expected decision and reason codes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parsePolicy, verifyRun } from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, fixtures), "utf8");
const policy = parsePolicy(read("agentproof.yaml"));
const expectations = JSON.parse(read("expectations.json")) as Record<string, { decision: string; reasons: string[]; note: string }>;

describe("fixture suite", () => {
  for (const [name, expected] of Object.entries(expectations)) {
    it(`${name}: ${expected.note}`, () => {
      const run = JSON.parse(read(`runs/${name}.json`));
      const enforced = verifyRun(run, { policy, mode: "enforce" });
      assert.equal(enforced.evaluated_decision, expected.decision);
      assert.equal(enforced.decision, expected.decision);
      assert.deepEqual([...enforced.reason_codes].sort(), [...expected.reasons].sort());

      // Observe mode: same evaluation, but the run continues.
      const observed = verifyRun(run, { policy, mode: "observe" });
      assert.equal(observed.decision, "allow");
      assert.equal(observed.evaluated_decision, expected.decision);
    });
  }

  it("advisory checks are reported but never decide", () => {
    const run = JSON.parse(read("runs/stale-source.json"));
    const receipt = verifyRun(run, { policy });
    const stale = receipt.checks.find((c) => c.reason === "SOURCE_STALE");
    assert.ok(stale);
    assert.equal(stale.required, false);
    assert.equal(receipt.decision, "allow");
  });

  it("is deterministic: same input, same checks", () => {
    const run = JSON.parse(read("runs/fabricated-quote.json"));
    const a = verifyRun(run, { policy, now: () => new Date("2026-10-19T12:00:00Z") });
    const b = verifyRun(run, { policy, now: () => new Date("2026-10-19T12:00:00Z") });
    assert.deepEqual(a.checks, b.checks);
    assert.equal(a.output_sha256, b.output_sha256);
  });
});
