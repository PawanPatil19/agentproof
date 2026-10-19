/**
 * Evidence checks: does each claim point at captured records, and do those
 * records actually contain what the claim relies on?
 *
 * A pass here means *reference integrity* — the cited record exists and
 * contains the quoted excerpt. It does not mean the claim is true.
 */
import type { EvidenceRecord } from "../types.ts";
import { sha256 } from "../util/hash.ts";
import { classifyLocator, normalizeForMatch } from "../util/text.ts";
import { pass, plural, result, type Check, type CheckContext, type RawResult } from "./context.ts";

const DAY_MS = 86_400_000;

function resolved(ctx: CheckContext, ids: string[]): EvidenceRecord[] {
  return ids.flatMap((id) => {
    const record = ctx.evidence.get(id);
    return record ? [record] : [];
  });
}

/** evidence.reference — every claim cites evidence, and every cited ID resolves to a non-empty record. */
export const checkReferences: Check = (ctx) =>
  ctx.claims.map((claim): RawResult => {
    const target = `claim:${claim.id}`;
    if (claim.evidence_ids.length === 0) {
      return ctx.policy.evidence.requireEvidenceForEachClaim
        ? result("evidence.reference", target, "fail", "EVIDENCE_MISSING", "Claim cites no evidence; the policy requires a source for every claim.")
        : result("evidence.reference", target, "not_applicable", "NOT_APPLICABLE", "Claim cites no evidence and none is required.");
    }
    const unknown = claim.evidence_ids.filter((id) => !ctx.evidence.has(id));
    if (unknown.length > 0) {
      return result(
        "evidence.reference",
        target,
        "fail",
        "EVIDENCE_UNKNOWN_ID",
        `Evidence ID ${unknown.join(", ")} does not resolve to a captured record. Request a repair from the worker.`,
      );
    }
    const empty = resolved(ctx, claim.evidence_ids).filter((r) => r.content !== undefined && r.content.trim() === "");
    if (empty.length > 0) {
      return result("evidence.reference", target, "fail", "EVIDENCE_EMPTY", `Evidence ${empty.map((r) => r.id).join(", ")} was captured with empty content.`);
    }
    return pass("evidence.reference", target, `${plural(claim.evidence_ids.length, "evidence record")} resolved.`);
  });

/** evidence.quote — the claim's quote appears verbatim (after normalization) in a cited record. */
export const checkQuotes: Check = (ctx) =>
  ctx.claims.map((claim): RawResult => {
    const target = `claim:${claim.id}`;
    const { requireQuote, minQuoteChars } = ctx.policy.evidence;
    if (claim.quote === undefined) {
      return requireQuote
        ? result("evidence.quote", target, "fail", "QUOTE_MISSING", "Claim has no quote; the policy requires an exact excerpt from the cited source.")
        : result("evidence.quote", target, "not_applicable", "NOT_APPLICABLE", "Claim carries no quote.");
    }
    const quote = normalizeForMatch(claim.quote);
    if (quote.length < minQuoteChars) {
      return result("evidence.quote", target, "fail", "QUOTE_TOO_SHORT", `Quote is ${quote.length} characters; at least ${minQuoteChars} are needed to ground a claim.`);
    }
    const records = resolved(ctx, claim.evidence_ids);
    if (records.length === 0) {
      // evidence.reference already fails this claim; don't report the same cause twice.
      return result("evidence.quote", target, "not_applicable", "NOT_APPLICABLE", "No cited evidence resolved; see evidence.reference.");
    }
    const withContent = records.filter((r) => typeof r.content === "string" && r.content.trim() !== "");
    const match = withContent.find((r) => normalizeForMatch(r.content as string).includes(quote));
    if (match) return pass("evidence.quote", target, `Quote found verbatim in ${match.id}.`);
    // Records captured *empty* were searched (and failed evidence.reference);
    // only records with no captured content leave the result open.
    const missing = records.filter((r) => r.content === undefined);
    if (missing.length > 0) {
      return result(
        "evidence.quote",
        target,
        "unknown",
        "QUOTE_CONTENT_UNAVAILABLE",
        `Quote not found in the content that was captured; ${missing.map((r) => r.id).join(", ")} had no captured content to search.`,
      );
    }
    return result(
      "evidence.quote",
      target,
      "fail",
      "QUOTE_NOT_FOUND",
      `Quote does not appear in cited evidence (${records.map((r) => r.id).join(", ")}). The source may not say this.`,
    );
  });

/** evidence.integrity — captured content still matches the hash recorded at capture time. */
export const checkIntegrity: Check = (ctx) => {
  if (!ctx.policy.evidence.verifyContentHash) return [];
  return ctx.cited.flatMap((record): RawResult[] => {
    if (record.content === undefined || record.content_sha256 === undefined) return [];
    const expected = record.content_sha256.replace(/^sha256:/, "").toLowerCase();
    const target = `evidence:${record.id}`;
    return sha256(record.content) === expected
      ? [pass("evidence.integrity", target, "Content matches its capture-time hash.")]
      : [result("evidence.integrity", target, "fail", "CONTENT_HASH_MISMATCH", "Content differs from the hash recorded at capture time.")];
  });
};

/** evidence.locator — locators are http(s) URLs or plain paths; never script/data schemes. */
export const checkLocators: Check = (ctx) =>
  ctx.cited.flatMap((record): RawResult[] => {
    if (record.locator === undefined) return [];
    const target = `evidence:${record.id}`;
    switch (classifyLocator(record.locator)) {
      case "unsafe":
        return [result("evidence.locator", target, "fail", "LOCATOR_UNSAFE", "Locator uses a disallowed scheme (javascript:, data:, file: or vbscript:).")];
      case "malformed":
        return [result("evidence.locator", target, "fail", "LOCATOR_MALFORMED", "Locator is not a well-formed URL or path.")];
      default:
        return [pass("evidence.locator", target, "Locator is well-formed.")];
    }
  });

/** evidence.source — cited records come from allowed sources. Runs only when an allowlist is configured. */
export const checkSources: Check = (ctx) => {
  const allowed = ctx.policy.evidence.allowedSourceIds;
  if (!allowed) return [];
  return ctx.cited.map((record): RawResult => {
    const target = `evidence:${record.id}`;
    if (!record.source_id) return result("evidence.source", target, "fail", "SOURCE_NOT_ALLOWED", "Record has no source_id, so its origin cannot be checked against the allowlist.");
    return allowed.has(record.source_id)
      ? pass("evidence.source", target, `Source '${record.source_id}' is allowed.`)
      : result("evidence.source", target, "fail", "SOURCE_NOT_ALLOWED", `Source '${record.source_id}' is not in allowed_source_ids.`);
  });
};

/** evidence.freshness — cited records were published within the allowed age, by trusted metadata. */
export const checkFreshness: Check = (ctx) => {
  const maxDays = ctx.policy.evidence.maxSourceAgeDays;
  if (maxDays === undefined) return [];
  return ctx.cited.map((record): RawResult => {
    const target = `evidence:${record.id}`;
    const published = record.published_at ? Date.parse(record.published_at) : Number.NaN;
    if (Number.isNaN(published)) {
      return result("evidence.freshness", target, "unknown", "SOURCE_DATE_MISSING", "No trusted publication date; capture time is not source freshness.");
    }
    const ageDays = Math.floor((ctx.referenceTime.getTime() - published) / DAY_MS);
    return ageDays > maxDays
      ? result("evidence.freshness", target, "fail", "SOURCE_STALE", `Published ${ageDays} days before submission; the limit is ${maxDays}.`)
      : pass("evidence.freshness", target, `Published ${Math.max(ageDays, 0)} days before submission (limit ${maxDays}).`);
  });
};
