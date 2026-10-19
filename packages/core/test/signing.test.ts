// Signed receipts: a counterparty can verify who issued a receipt and that it is unedited.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateSigningKey, parsePolicy, parseReceipt, seal, signReceipt, verifyReceiptDigest, verifyReceiptSignature, verifyRun } from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const policy = parsePolicy(readFileSync(new URL("agentproof.yaml", fixtures), "utf8"));
const receipt = () => verifyRun(JSON.parse(readFileSync(new URL("runs/valid.json", fixtures), "utf8")), { policy });

describe("signed receipts", () => {
  const issuer = generateSigningKey();
  const stranger = generateSigningKey();

  it("verify with the issuer's public key", () => {
    const signed = signReceipt(receipt(), issuer.privateKeyPem);
    assert.equal(signed.signature?.key_id, issuer.keyId);
    assert.deepEqual(verifyReceiptSignature(signed, issuer.publicKeyPem), { ok: true, keyId: issuer.keyId });
    assert.ok(verifyReceiptDigest(signed), "the signature is not part of the digest");
    assert.ok(parseReceipt(signed).ok);
  });

  it("reject edits, even when re-sealed with the old signature copied over", () => {
    const signed = signReceipt(receipt(), issuer.privateKeyPem);
    assert.deepEqual(verifyReceiptSignature({ ...signed, decision: "block" }, issuer.publicKeyPem), { ok: false, reason: "DIGEST_MISMATCH" });
    const resealed = { ...seal({ ...signed, decision: "block" }), signature: signed.signature };
    assert.deepEqual(verifyReceiptSignature(resealed, issuer.publicKeyPem), { ok: false, reason: "BAD_SIGNATURE" });
  });

  it("reject a different key and unsigned receipts", () => {
    const forged = signReceipt(receipt(), stranger.privateKeyPem);
    assert.deepEqual(verifyReceiptSignature(forged, issuer.publicKeyPem), { ok: false, reason: "WRONG_KEY" });
    assert.deepEqual(verifyReceiptSignature(receipt(), issuer.publicKeyPem), { ok: false, reason: "UNSIGNED" });
  });

  it("re-sealing drops a stale signature", () => {
    const signed = signReceipt(receipt(), issuer.privateKeyPem);
    assert.equal(seal(signed).signature, undefined);
  });
});
