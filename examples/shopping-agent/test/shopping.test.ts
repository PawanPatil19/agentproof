// The demo's claims, as tests: what reached the payments server, why each call was stopped, and that receipts verify.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifyReceiptSignature } from "@agentproof/core";
import { runShopping } from "../src/shop.ts";

describe("shopping agent behind the MCP gateway", async () => {
  const run = await runShopping();

  test("the agent is not shown the tool its contract refuses", () => {
    assert.deepEqual(run.visibleTools, ["catalog.search", "payments.send"]);
  });

  test("each call is decided by the contract, with the expected reason", () => {
    assert.deepEqual(
      run.steps.map((s) => [s.tool, s.decision, s.reasonCode ?? null]),
      [
        ["catalog.search", "allow", null],
        ["payments.send", "allow", null],
        ["payments.send", "block", "TOOL_LIMIT_EXCEEDED"], // over SGD 80 a payment
        ["payments.send", "block", "TOOL_ARGS_INVALID"], // merchant not approved
        ["payments.send", "allow", null],
        ["payments.send", "block", "TOOL_LIMIT_EXCEEDED"], // over SGD 150 a day
        ["wallet.export_keys", "block", "TOOL_NOT_ALLOWED"],
      ],
    );
  });

  test("only allowed payments reach the payments server, and the key export never runs", () => {
    assert.deepEqual(run.payments.map((p) => [p.merchant, p.amount]), [["challenger", 59.9], ["popular-bookstore", 42.5]]);
    assert.equal(run.keyExports, 0);
    assert.deepEqual(run.steps.map((s) => s.executed), [true, true, false, false, true, false, false]);
  });

  test("the daily spend carries across calls, so a blocked payment does not use budget", () => {
    assert.deepEqual(run.steps.map((s) => s.spentToday ?? null), [null, 59.9, 59.9, 59.9, 102.4, 102.4, null]);
  });

  test("blocked calls come back to the agent as errors with a receipt summary", () => {
    for (const step of run.steps) {
      assert.equal(step.result.isError === true, step.decision !== "allow");
      assert.equal((step.result._meta?.["agentproof/receipt"] as { receipt_sha256: string }).receipt_sha256, step.receipt.receipt_sha256);
    }
  });

  test("every call leaves one signed receipt, and an edited receipt fails verification", () => {
    assert.equal(run.receipts.length, run.steps.length);
    for (const receipt of run.receipts) assert.equal(verifyReceiptSignature(receipt, run.publicKeyPem).ok, true);
    const laptop = run.steps[2]!.receipt;
    const edited = { ...laptop, decision: "allow" as const };
    assert.deepEqual(verifyReceiptSignature(edited, run.publicKeyPem), { ok: false, reason: "DIGEST_MISMATCH" });
  });
});
