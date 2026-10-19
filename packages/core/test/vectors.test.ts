// The published conformance vectors (docs/spec/receipt-vectors.json) still
// hold byte for byte. If this fails, the receipt format changed: bump the
// spec version, update docs/RECEIPT_SPEC.md and regenerate the vectors.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DSSE_PAYLOAD_TYPE,
  RECEIPT_VERSION,
  canonicalJson,
  claimSalt,
  commitClaimText,
  fromDsseEnvelope,
  keyIdOf,
  parseReceipt,
  preAuthEncoding,
  receiptPayload,
  seal,
  sha256,
  signReceipt,
  toDsseEnvelope,
  verifyClaimDisclosure,
  verifyReceiptSignature,
  type Receipt,
} from "@agentproof/core";

const v = JSON.parse(readFileSync(new URL("../../../docs/spec/receipt-vectors.json", import.meta.url), "utf8"));
const seedKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(v.keys.ed25519_seed_hex, "hex")]),
  format: "der",
  type: "pkcs8",
});
const privateKeyPem = seedKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem: string = v.keys.ed25519_public_key_pem;

describe("receipt conformance vectors", () => {
  it("describe the current receipt version", () => {
    assert.equal(v.spec_version, RECEIPT_VERSION);
  });

  it("canonical JSON", () => {
    for (const c of v.canonical_json) {
      assert.equal(canonicalJson(JSON.parse(c.input_json)), c.canonical, c.name);
      assert.equal(sha256(c.canonical), c.sha256, c.name);
    }
  });

  it("claim salts and commitments", () => {
    const key = Buffer.from(v.keys.commitment_key_hex, "hex");
    for (const c of v.claim_commitments) {
      const salt = claimSalt(key, c.run_id, c.claim_id);
      assert.equal(salt.toString("hex"), c.salt);
      assert.equal(commitClaimText(salt, c.text), c.text_commitment);
    }
  });

  it("receipt digest, statement, PAE, signature and envelope", () => {
    const r = v.receipt;
    const unsigned = r.unsigned_receipt as Receipt;
    assert.ok(parseReceipt(unsigned).ok);
    assert.equal(seal(unsigned).receipt_sha256, r.receipt_sha256);
    assert.equal(keyIdOf(publicKeyPem), v.keys.key_id);

    const signed = signReceipt(unsigned, privateKeyPem);
    assert.deepEqual(signed, r.signed_receipt);
    assert.equal(signed.signature?.value, r.signature_b64, "Ed25519 is deterministic");
    assert.equal(receiptPayload(signed).toString("utf8"), r.statement_canonical);
    assert.equal(preAuthEncoding(DSSE_PAYLOAD_TYPE, receiptPayload(signed)).toString("hex"), r.pae_hex);
    assert.deepEqual(toDsseEnvelope(signed), r.dsse_envelope);

    assert.deepEqual(verifyReceiptSignature(r.signed_receipt, publicKeyPem), { ok: true, keyId: v.keys.key_id });
    const opened = fromDsseEnvelope(r.dsse_envelope);
    assert.ok(opened.ok);
    assert.deepEqual(verifyReceiptSignature(opened.receipt, publicKeyPem), { ok: true, keyId: v.keys.key_id });
    assert.ok(verifyClaimDisclosure(unsigned, r.disclosure));
  });
});
