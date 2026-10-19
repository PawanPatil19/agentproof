/**
 * Salted claim commitments. A receipt never carries a plain hash of claim
 * text: claims are short and predictable ("Revenue grew 12% in Q3"), so
 * anyone holding the receipt could hash likely sentences and confirm a
 * match. Instead each claim carries
 *
 *   text_commitment = "hmac-sha256:" + hex(HMAC-SHA256(key = salt, msg = UTF-8 text))
 *
 * with a 32-byte salt per claim that never appears in the receipt. The
 * salt is derived from a commitment key the issuer keeps and a random
 * per-receipt nonce that the receipt records (`commitment_nonce`):
 *
 *   salt = HMAC-SHA256(key = commitment key, msg = "agentproof.claim-salt/v2" 0x00 commitment_nonce 0x00 claim_id)
 *
 * The nonce makes every receipt's salts unique even when an agent reuses
 * a run ID, so a salt disclosed for one receipt opens nothing in another.
 *
 * so the issuer can later open one claim to one auditor by handing over
 * (claim_id, salt, text). Opening one claim reveals nothing about the
 * others. Without a commitment key the engine uses a fresh random key per
 * receipt, and the claims can never be opened (fine when nobody needs to).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Receipt } from "./types.ts";

export const COMMITMENT_PREFIX = "hmac-sha256:";
const SALT_LABEL = "agentproof.claim-salt/v2";

/** Key material for a commitment key: raw bytes, or a hex string. At least 16 bytes (32 recommended). */
export type CommitmentKey = Uint8Array | string;

/** A fresh random 32-byte commitment key, hex encoded. Store it as a secret alongside your signing key. */
export function generateCommitmentKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Decode a commitment key. Strings must be plain hex (surrounding whitespace,
 * such as a trailing newline in a key file, is ignored); anything else is
 * rejected rather than guessed at, so a typo can't silently become another key.
 */
export function commitmentKeyBytes(key: CommitmentKey): Buffer {
  let bytes: Buffer;
  if (typeof key !== "string") bytes = Buffer.from(key);
  else {
    const text = key.trim();
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) throw new Error("A commitment key must be hex encoded (e.g. from generateCommitmentKey()).");
    bytes = Buffer.from(text, "hex");
  }
  if (bytes.length < 16) throw new Error("A commitment key must be at least 16 bytes (32 recommended).");
  return bytes;
}

/** A fresh per-receipt nonce: 16 random bytes, hex encoded. */
export function generateCommitmentNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Derive the salt for one claim of one receipt. */
export function claimSalt(key: CommitmentKey, nonce: string, claimId: string): Buffer {
  return createHmac("sha256", commitmentKeyBytes(key))
    .update(Buffer.concat([Buffer.from(SALT_LABEL, "utf8"), Buffer.of(0), Buffer.from(nonce, "utf8"), Buffer.of(0), Buffer.from(claimId, "utf8")]))
    .digest();
}

/** Commit to claim text under a salt. */
export function commitClaimText(salt: Uint8Array, text: string): string {
  return COMMITMENT_PREFIX + createHmac("sha256", salt).update(text, "utf8").digest("hex");
}

/** What an issuer hands an auditor to open one claim. */
export interface ClaimDisclosure {
  claim_id: string;
  /** The claim's salt, hex encoded (32 bytes). */
  salt: string;
  text: string;
}

/**
 * Open one claim of a receipt for an auditor. Throws if the receipt has no
 * such claim or the text does not match its commitment under this key (the
 * wrong key or the wrong text), so an issuer can't disclose a mismatch by
 * accident.
 */
export function discloseClaim(key: CommitmentKey, receipt: Receipt, claimId: string, text: string): ClaimDisclosure {
  const salt = claimSalt(key, receipt.commitment_nonce, claimId);
  const disclosure = { claim_id: claimId, salt: salt.toString("hex"), text };
  if (!verifyClaimDisclosure(receipt, disclosure)) {
    throw new Error(`Claim '${claimId}' does not match its commitment under this key and text.`);
  }
  return disclosure;
}

/** True when the disclosed text and salt open the named claim's commitment. */
export function verifyClaimDisclosure(receipt: Receipt, disclosure: ClaimDisclosure): boolean {
  const claim = receipt.claims.find((c) => c.id === disclosure.claim_id);
  if (!claim || !/^[0-9a-f]{64}$/.test(disclosure.salt)) return false;
  const expected = Buffer.from(commitClaimText(Buffer.from(disclosure.salt, "hex"), disclosure.text), "utf8");
  const actual = Buffer.from(claim.text_commitment, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
