import { createHash } from "node:crypto";

/**
 * Canonical JSON per RFC 8785 (JSON Canonicalization Scheme, JCS). Used for
 * every digest and for the signed receipt payload.
 *
 * For any I-JSON value the output is exactly JCS: object keys sorted by
 * UTF-16 code units (JavaScript's default string order), numbers in
 * ECMAScript shortest round-trip form and strings escaped only where JSON
 * requires it (both what `JSON.stringify` emits), no whitespace.
 * JavaScript-only values are first mapped the way `JSON.stringify` maps
 * them (`undefined` members dropped, `toJSON` applied, NaN/Infinity to
 * null, lone surrogates escaped as \uXXXX). Receipts never contain such
 * values; see docs/RECEIPT_SPEC.md.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value) ?? "null";
}

/**
 * Write JSON by hand rather than via `JSON.stringify` on a key-sorted copy:
 * JavaScript objects always enumerate integer-like keys ("1", "42") first,
 * whatever order they were inserted in, which would break JCS key order.
 * Returns undefined for values JSON omits (undefined, functions, symbols).
 */
function serialize(value: unknown): string | undefined {
  // Match JSON.stringify: Dates and other toJSON-capable values serialize first.
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return serialize((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v) ?? "null").join(",")}]`;
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = serialize((value as Record<string, unknown>)[key]);
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
    }
    return `{${parts.join(",")}}`;
  }
  // Primitives: JSON.stringify already emits JCS numbers and strings.
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of canonical JSON, prefixed so digests are self-describing. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}
