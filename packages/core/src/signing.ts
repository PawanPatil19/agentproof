/**
 * Signed receipts, in a standard format. A sealed receipt detects edits; a
 * signed one proves *who* issued it. A counterparty holding your public key
 * can verify a receipt without trusting the channel, and without running
 * AgentProof: the signature is a DSSE signature over an in-toto Statement
 * (the format SLSA and Sigstore use), so stock DSSE / in-toto tooling can
 * check it. The full format is in docs/RECEIPT_SPEC.md.
 *
 *   statement = { _type: in-toto Statement v1,
 *                 subject: [{ name: "output", digest: { sha256: output_sha256 } }],
 *                 predicateType: "https://agentproof.dev/receipt/v2",
 *                 predicate: the receipt without `signature` }
 *   payload   = UTF-8 bytes of RFC 8785 canonical JSON of the statement
 *   signature = Ed25519 over DSSE PAE("application/vnd.in-toto+json", payload)
 *
 * A receipt file keeps the signature inline (`receipt.signature`), and
 * `toDsseEnvelope` / `fromDsseEnvelope` convert to and from the standard
 * envelope. Because the payload is canonical, the two forms are equivalent.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { Receipt } from "./types.ts";
import { canonicalJson } from "./util/hash.ts";
import { verifyReceiptDigest } from "./receipt.ts";
import { parseReceipt } from "./report/schema.ts";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const RECEIPT_PREDICATE_TYPE = "https://agentproof.dev/receipt/v2";

export interface SigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

export interface InTotoStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: typeof RECEIPT_PREDICATE_TYPE;
  predicate: Omit<Receipt, "signature">;
}

/** A DSSE envelope (https://github.com/secure-systems-lab/dsse). `payload` and `sig` are standard base64. */
export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

/** Short, stable identifier for a public key: first 16 hex chars of sha256 over its SPKI DER bytes. */
export function keyIdOf(publicKey: string | KeyObject): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

export function generateSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: keyIdOf(publicKey),
  };
}

/** The in-toto Statement a receipt is signed as. */
export function receiptStatement(receipt: Receipt): InTotoStatement {
  const { signature: _signature, ...predicate } = receipt;
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: "output", digest: { sha256: receipt.output_sha256 } }],
    predicateType: RECEIPT_PREDICATE_TYPE,
    predicate,
  };
}

/** Canonical payload bytes for a receipt: RFC 8785 JSON of its statement. */
export function receiptPayload(receipt: Receipt): Buffer {
  return Buffer.from(canonicalJson(receiptStatement(receipt)), "utf8");
}

/** DSSE pre-authentication encoding: "DSSEv1" SP len(type) SP type SP len(body) SP body. */
export function preAuthEncoding(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type, Buffer.from(` ${payload.length} `, "utf8"), payload]);
}

/** Attach an Ed25519 DSSE signature over the receipt's statement. */
export function signReceipt(receipt: Receipt, privateKeyPem: string): Receipt {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Receipt signing requires an Ed25519 private key.");
  const { signature: _old, ...unsigned } = receipt;
  const value = sign(null, preAuthEncoding(DSSE_PAYLOAD_TYPE, receiptPayload(unsigned)), key).toString("base64");
  return { ...unsigned, signature: { alg: "ed25519", key_id: keyIdOf(createPublicKey(key)), value } };
}

export type SignatureFailure =
  | "UNSIGNED"
  | "DIGEST_MISMATCH"
  | "WRONG_KEY"
  | "BAD_SIGNATURE"
  | "UNSUPPORTED_ALG"
  | "MALFORMED_ENVELOPE";

export type SignatureCheck = { ok: true; keyId: string } | { ok: false; reason: SignatureFailure };

/**
 * Verify a receipt against a trusted public key: the digest must match the
 * contents, the key ID must match the key, and the DSSE signature over the
 * receipt's statement must verify.
 */
export function verifyReceiptSignature(receipt: Receipt, publicKeyPem: string): SignatureCheck {
  const sig = receipt.signature;
  if (!sig) return { ok: false, reason: "UNSIGNED" };
  if (sig.alg !== "ed25519") return { ok: false, reason: "UNSUPPORTED_ALG" };
  // Exactly one encoding per signature: lenient base64 would let different files verify as the same receipt.
  const sigBytes = canonicalBase64(sig.value);
  if (sigBytes?.length !== 64) return { ok: false, reason: "BAD_SIGNATURE" };
  if (!verifyReceiptDigest(receipt)) return { ok: false, reason: "DIGEST_MISMATCH" };
  const key = createPublicKey(publicKeyPem);
  if (keyIdOf(key) !== sig.key_id) return { ok: false, reason: "WRONG_KEY" };
  const ok = verify(null, preAuthEncoding(DSSE_PAYLOAD_TYPE, receiptPayload(receipt)), key, sigBytes);
  return ok ? { ok: true, keyId: sig.key_id } : { ok: false, reason: "BAD_SIGNATURE" };
}

/** Decode standard base64 only if it is in canonical form (padded, no stray characters or bits). */
function canonicalBase64(text: string): Buffer | undefined {
  if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : undefined;
}

/** Export a signed receipt as a standard DSSE envelope. */
export function toDsseEnvelope(receipt: Receipt): DsseEnvelope {
  if (!receipt.signature) throw new Error("Only a signed receipt can be exported as a DSSE envelope.");
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: receiptPayload(receipt).toString("base64"),
    signatures: [{ keyid: receipt.signature.key_id, sig: receipt.signature.value }],
  };
}

/** True when a value has the shape of a DSSE envelope (as opposed to a bare receipt). */
export function isDsseEnvelope(value: unknown): value is DsseEnvelope {
  const v = value as Partial<DsseEnvelope> | null;
  return typeof v === "object" && v !== null && typeof v.payloadType === "string" && typeof v.payload === "string" && Array.isArray(v.signatures);
}

export type EnvelopeParse = { ok: true; receipt: Receipt } | { ok: false; reason: "MALFORMED_ENVELOPE"; problems: string };

/**
 * Read a receipt back out of a DSSE envelope, with its signature attached
 * inline. The payload must be the canonical form of an AgentProof receipt
 * statement, so a verified envelope and its inline receipt are the same
 * signed bytes. Verify the result with `verifyReceiptSignature`.
 */
export function fromDsseEnvelope(envelope: DsseEnvelope): EnvelopeParse {
  try {
    return openEnvelope(envelope);
  } catch (error) {
    // Envelopes are untrusted input: anything unexpected is a malformed envelope, never a crash.
    return { ok: false, reason: "MALFORMED_ENVELOPE", problems: `unreadable envelope: ${(error as Error).message}` };
  }
}

function openEnvelope(envelope: DsseEnvelope): EnvelopeParse {
  const bad = (problems: string): EnvelopeParse => ({ ok: false, reason: "MALFORMED_ENVELOPE", problems });
  if (!isDsseEnvelope(envelope)) return bad("not a DSSE envelope");
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE) return bad(`payloadType must be ${DSSE_PAYLOAD_TYPE}`);
  if (envelope.signatures.length !== 1) return bad("expected exactly one signature");
  const [signature] = envelope.signatures;
  if (typeof signature?.keyid !== "string" || typeof signature.sig !== "string") return bad("signature needs keyid and sig");
  const payload = canonicalBase64(envelope.payload);
  if (!payload) return bad("payload must be canonical standard base64");
  let statement: Partial<InTotoStatement>;
  try {
    statement = JSON.parse(payload.toString("utf8")) as Partial<InTotoStatement>;
  } catch {
    return bad("payload is not JSON");
  }
  if (statement === null || typeof statement !== "object" || Array.isArray(statement)) return bad("payload is not a JSON object");
  if (statement._type !== IN_TOTO_STATEMENT_TYPE) return bad(`_type must be ${IN_TOTO_STATEMENT_TYPE}`);
  if (statement.predicateType !== RECEIPT_PREDICATE_TYPE) return bad(`predicateType must be ${RECEIPT_PREDICATE_TYPE}`);
  const parsed = parseReceipt(statement.predicate);
  if (!parsed.ok) return bad(`predicate is not a valid receipt: ${parsed.problems}`);
  if (parsed.receipt.signature) return bad("predicate must not carry its own signature");
  const receipt: Receipt = { ...parsed.receipt, signature: { alg: "ed25519", key_id: signature.keyid, value: signature.sig } };
  // Bind the envelope's exact bytes to the receipt: the subject must match and
  // the payload must be canonical, or the two forms could say different things.
  if (!payload.equals(receiptPayload(receipt))) return bad("payload is not the canonical statement for its receipt (subject or encoding differs)");
  return { ok: true, receipt };
}
