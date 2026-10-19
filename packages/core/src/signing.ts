/**
 * Signed receipts. A sealed receipt detects edits; a signed one proves *who*
 * issued it. A counterparty holding your public key can verify a receipt
 * without trusting the channel or the party that forwarded it — the basis
 * for handoffs between teams or vendors.
 *
 * Ed25519 via node:crypto. The signature covers `receipt_sha256`, which in
 * turn covers every other field, so signing the digest signs the receipt.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { Receipt } from "./types.ts";
import { sha256 } from "./util/hash.ts";
import { verifyReceiptDigest } from "./receipt.ts";

export interface SigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

/** Short, stable identifier for a public key: first 16 hex chars of sha256(SPKI DER). */
export function keyIdOf(publicKey: string | KeyObject): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  return sha256(key.export({ type: "spki", format: "der" }).toString("base64")).slice(0, 16);
}

export function generateSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: keyIdOf(publicKey),
  };
}

/** Attach an Ed25519 signature over the receipt digest. */
export function signReceipt(receipt: Receipt, privateKeyPem: string): Receipt {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Receipt signing requires an Ed25519 private key.");
  const value = sign(null, Buffer.from(receipt.receipt_sha256, "utf8"), key).toString("base64");
  return { ...receipt, signature: { alg: "ed25519", key_id: keyIdOf(createPublicKey(key)), value } };
}

export type SignatureCheck =
  | { ok: true; keyId: string }
  | { ok: false; reason: "UNSIGNED" | "DIGEST_MISMATCH" | "WRONG_KEY" | "BAD_SIGNATURE" | "UNSUPPORTED_ALG" };

/**
 * Verify a receipt against a trusted public key: the digest must match the
 * contents, the key ID must match the key, and the signature must verify.
 */
export function verifyReceiptSignature(receipt: Receipt, publicKeyPem: string): SignatureCheck {
  const sig = receipt.signature;
  if (!sig) return { ok: false, reason: "UNSIGNED" };
  if (sig.alg !== "ed25519") return { ok: false, reason: "UNSUPPORTED_ALG" };
  if (!verifyReceiptDigest(receipt)) return { ok: false, reason: "DIGEST_MISMATCH" };
  const key = createPublicKey(publicKeyPem);
  if (keyIdOf(key) !== sig.key_id) return { ok: false, reason: "WRONG_KEY" };
  const ok = verify(null, Buffer.from(receipt.receipt_sha256, "utf8"), key, Buffer.from(sig.value, "base64"));
  return ok ? { ok: true, keyId: sig.key_id } : { ok: false, reason: "BAD_SIGNATURE" };
}
