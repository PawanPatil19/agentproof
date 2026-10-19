/**
 * Regenerate docs/spec/receipt-vectors.json, the conformance vectors for
 * docs/RECEIPT_SPEC.md. Every value is derived from fixed inputs (a test
 * key from RFC 8032, a fixed commitment key, a fixed clock), so the file
 * only changes when the format does. packages/core/test/vectors.test.ts
 * checks the library still reproduces it byte for byte.
 *
 *   node --experimental-strip-types --no-warnings --conditions=source scripts/make-receipt-vectors.ts
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalJson,
  claimSalt,
  commitClaimText,
  keyIdOf,
  parsePolicy,
  preAuthEncoding,
  receiptPayload,
  seal,
  sha256,
  signReceipt,
  toDsseEnvelope,
  verifyRun,
  DSSE_PAYLOAD_TYPE,
} from "@agentproof/core";

const root = new URL("../", import.meta.url);

// RFC 8032 §7.1 TEST 1. A published test key: never use it for real receipts.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED_HEX, "hex")]), format: "der", type: "pkcs8" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
const COMMITMENT_KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

// 1. Canonical JSON (RFC 8785).
const jcs = [
  { name: "rfc8785-3.2.2", input_json: '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}' },
  { name: "key-order-utf16", input_json: '{"\\u20ac":1,"\\r":2,"\\ufb33":3,"1":4,"\\ud83d\\ude00":5,"\\u0080":6,"\\u00f6":7,"":8}' },
  { name: "nested", input_json: '{"b":[{"z":0,"a":-0.0},1e21,1e-7],"a":{"10":"x","9":"y"}}' },
].map((v) => {
  const canonical = canonicalJson(JSON.parse(v.input_json));
  return { ...v, canonical, sha256: sha256(canonical) };
});

// 2. Salted claim commitments.
const commitments = [
  { run_id: "fx-valid", claim_id: "c1", text: "The Pro plan costs $12 per member per month." },
  { run_id: "fx-valid", claim_id: "c2", text: "Revenue grew 12% in Q3." },
  { run_id: "run-ünïcode", claim_id: "c-1", text: "Größe: 12 € 😀" },
].map((v) => {
  const salt = claimSalt(Buffer.from(COMMITMENT_KEY_HEX, "hex"), v.run_id, v.claim_id);
  return { ...v, salt: salt.toString("hex"), text_commitment: commitClaimText(salt, v.text) };
});

// 3. One complete receipt: sealed, signed, and as a DSSE envelope.
const policy = parsePolicy(readFileSync(new URL("fixtures/agentproof.yaml", root), "utf8"));
const run = JSON.parse(readFileSync(new URL("fixtures/runs/valid.json", root), "utf8"));
const evaluated = verifyRun(run, { policy, now: () => new Date("2026-10-19T12:00:00.000Z"), commitmentKey: COMMITMENT_KEY_HEX });
const { receipt_sha256: _d, ...body } = evaluated;
const unsigned = seal(JSON.parse(JSON.stringify({ ...body, duration_ms: 1.25 })));
const signed = signReceipt(unsigned, privateKeyPem);
const payload = receiptPayload(signed);

const vectors = {
  description: "Conformance vectors for the AgentProof receipt format (docs/RECEIPT_SPEC.md). Regenerate with scripts/make-receipt-vectors.ts.",
  spec_version: "agentproof.receipt/v2",
  keys: {
    warning: "Published test keys (RFC 8032 §7.1 TEST 1). Never use them for real receipts.",
    ed25519_seed_hex: SEED_HEX,
    ed25519_public_key_pem: publicKeyPem,
    key_id: keyIdOf(publicKeyPem),
    commitment_key_hex: COMMITMENT_KEY_HEX,
  },
  canonical_json: jcs,
  claim_commitments: commitments,
  receipt: {
    unsigned_receipt: unsigned,
    receipt_sha256: unsigned.receipt_sha256,
    statement_canonical: payload.toString("utf8"),
    pae_hex: preAuthEncoding(DSSE_PAYLOAD_TYPE, payload).toString("hex"),
    signature_b64: signed.signature!.value,
    signed_receipt: signed,
    dsse_envelope: toDsseEnvelope(signed),
    disclosure: { claim_id: "c1", salt: claimSalt(Buffer.from(COMMITMENT_KEY_HEX, "hex"), "fx-valid", "c1").toString("hex"), text: run.output.claims[0].text },
  },
};

writeFileSync(new URL("docs/spec/receipt-vectors.json", root), `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote docs/spec/receipt-vectors.json · receipt ${unsigned.receipt_sha256.slice(0, 16)} · key ${vectors.keys.key_id}`);
