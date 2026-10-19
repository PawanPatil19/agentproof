/**
 * Text helpers for quote matching, redaction and safe display.
 */

/**
 * Normalize text for verbatim-quote comparison. Tolerates differences that a
 * renderer or tokenizer introduces (case, whitespace, curly quotes, dashes,
 * ligatures) but nothing that changes wording.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:api-key]"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
];

/**
 * Best-effort removal of well-known secret formats. Redaction can miss
 * sensitive content; it is a seatbelt, not a guarantee.
 */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export type LocatorKind = "url" | "path" | "unsafe" | "malformed";

/** Classify a locator. Only http(s) URLs and plain paths/identifiers are acceptable. */
export function classifyLocator(locator: string): LocatorKind {
  const trimmed = locator.trim();
  if (trimmed === "") return "malformed";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  if (!scheme || /^[a-zA-Z]$/.test(scheme)) return "path"; // no scheme, or a Windows drive letter
  if (scheme !== "http" && scheme !== "https") {
    return ["javascript", "data", "vbscript", "file"].includes(scheme) ? "unsafe" : "path";
  }
  try {
    const url = new URL(trimmed);
    return url.hostname ? "url" : "malformed";
  } catch {
    return "malformed";
  }
}

/** Remove query string, fragment and credentials from URLs; leave paths as-is. */
export function sanitizeLocator(locator: string): string {
  if (classifyLocator(locator) !== "url") return redact(locator);
  const url = new URL(locator.trim());
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
