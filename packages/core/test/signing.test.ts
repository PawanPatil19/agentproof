// Signed receipts: a counterparty can verify who issued a receipt and that it is unedited.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  RECEIPT_PREDICATE_TYPE,
  canonicalJson,
  fromDsseEnvelope,
  generateSigningKey,
  keyIdOf,
  parsePolicy,
  parseReceipt,
  seal,
  signReceipt,
  toDsseEnvelope,
  verifyReceiptDigest,
  verifyReceiptSignature,
  verifyRun,
} from "@agentproof/core";

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

describe("receipts as DSSE / in-toto attestations", () => {
  const issuer = generateSigningKey();
  const stranger = generateSigningKey();

  it("export to a standard envelope whose signature verifies over PAE(payloadType, payload)", () => {
    const signed = signReceipt(receipt(), issuer.privateKeyPem);
    const env = toDsseEnvelope(signed);
    assert.equal(env.payloadType, "application/vnd.in-toto+json");
    assert.deepEqual(env.signatures, [{ keyid: issuer.keyId, sig: signed.signature?.value }]);
    const payload = Buffer.from(env.payload, "base64");
    // Independent of AgentProof's helpers: rebuild PAE by hand and verify with node:crypto.
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${env.payloadType.length} ${env.payloadType} ${payload.length} `), payload]);
    assert.ok(verify(null, pae, createPublicKey(issuer.publicKeyPem), Buffer.from(env.signatures[0]!.sig, "base64")));
    const statement = JSON.parse(payload.toString("utf8"));
    assert.equal(statement._type, "https://in-toto.io/Statement/v1");
    assert.equal(statement.predicateType, RECEIPT_PREDICATE_TYPE);
    assert.deepEqual(statement.subject, [{ name: "output", digest: { sha256: signed.output_sha256 } }]);
    assert.equal(statement.predicate.signature, undefined);
    assert.equal(statement.predicate.receipt_sha256, signed.receipt_sha256);
    assert.equal(payload.toString("utf8"), canonicalJson(statement), "payload is RFC 8785 canonical");
  });

  it("round-trip: envelope → receipt verifies, and equals the inline form", () => {
    const signed = signReceipt(receipt(), issuer.privateKeyPem);
    const opened = fromDsseEnvelope(toDsseEnvelope(signed));
    assert.ok(opened.ok);
    assert.equal(canonicalJson(opened.receipt), canonicalJson(signed));
    assert.deepEqual(verifyReceiptSignature(opened.receipt, issuer.publicKeyPem), { ok: true, keyId: issuer.keyId });
    assert.deepEqual(verifyReceiptSignature(opened.receipt, stranger.publicKeyPem), { ok: false, reason: "WRONG_KEY" });
  });

  it("reject envelopes that are edited, mislabelled or non-canonical", () => {
    const env = toDsseEnvelope(signReceipt(receipt(), issuer.privateKeyPem));
    const statement = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
    const withPayload = (s: unknown, raw?: string) => ({ ...env, payload: Buffer.from(raw ?? canonicalJson(s)).toString("base64") });

    assert.equal(fromDsseEnvelope({ ...env, payloadType: "application/json" }).ok, false);
    assert.equal(fromDsseEnvelope(withPayload({ ...statement, predicateType: "https://example.com/other" })).ok, false);
    assert.equal(fromDsseEnvelope(withPayload({ ...statement, subject: [{ name: "output", digest: { sha256: "0".repeat(64) } }] })).ok, false, "subject must match the output digest");
    assert.equal(fromDsseEnvelope(withPayload(statement, JSON.stringify(statement, null, 1))).ok, false, "non-canonical bytes are refused");
    assert.equal(fromDsseEnvelope(withPayload(null, "not json")).ok, false);
    assert.equal(fromDsseEnvelope({ ...env, signatures: [] }).ok, false);

    // An edited predicate parses, but its digest no longer matches.
    const edited = fromDsseEnvelope(withPayload({ ...statement, predicate: { ...statement.predicate, decision: "block" } }));
    assert.ok(edited.ok);
    assert.deepEqual(verifyReceiptSignature(edited.receipt, issuer.publicKeyPem), { ok: false, reason: "DIGEST_MISMATCH" });
    // Edited and re-sealed: the digest matches, the signature does not.
    const resealed = seal({ ...statement.predicate, decision: "block" });
    const forged = fromDsseEnvelope(withPayload({ ...statement, predicate: resealed }));
    assert.ok(forged.ok);
    assert.deepEqual(verifyReceiptSignature(forged.receipt, issuer.publicKeyPem), { ok: false, reason: "BAD_SIGNATURE" });
  });

  it("key IDs are sha256 over the SPKI DER bytes", () => {
    const der = createPublicKey(issuer.publicKeyPem).export({ type: "spki", format: "der" });
    assert.equal(keyIdOf(issuer.publicKeyPem), createHash("sha256").update(der).digest("hex").slice(0, 16));
  });

  it("a receipt signed with an old-style signature over the digest string does not verify", () => {
    const r = receipt();
    const legacy = sign(null, Buffer.from(r.receipt_sha256, "utf8"), createPrivateKey(issuer.privateKeyPem)).toString("base64");
    assert.deepEqual(verifyReceiptSignature({ ...r, signature: { alg: "ed25519", key_id: issuer.keyId, value: legacy } }, issuer.publicKeyPem), { ok: false, reason: "BAD_SIGNATURE" });
  });
});
