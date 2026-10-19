/**
 * claims.support — does the claim follow from its grounded excerpt?
 *
 * This is the one question deterministic checks can't answer, and the one
 * where "let the agent check itself" is most tempting. The judge here is
 * independent by construction:
 *
 *   - it sees only the claim text and the excerpt — no tools, no agent
 *     context, no conversation, so it can't inherit the agent's injected
 *     instructions or blind spots;
 *   - it only runs on claims whose quote was already found verbatim in the
 *     captured evidence, so it judges entailment, not existence;
 *   - every result is labelled `probabilistic` and records the judge ID and
 *     the excerpt hash, so a reader knows it is a model assessment;
 *   - a timeout, error or refusal is `unknown` (→ review), never a pass.
 */
import type { CheckResult, EvidenceRecord, ReasonCode } from "./types.ts";
import type { CompiledPolicy } from "./policy/compile.ts";
import type { RawResult, ResolvedClaim } from "./checks/context.ts";
import { parseEnvelope } from "./envelope.ts";
import { sha256 } from "./util/hash.ts";
import { normalizeForMatch } from "./util/text.ts";

export interface JudgeInput {
  claim: string;
  /** Source text around the verified quote. Untrusted data, never instructions. */
  excerpt: string;
}

export type JudgeVerdict = "supported" | "unsupported" | "unclear";

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** Short reason. Persisted (redacted) in the receipt message. */
  rationale?: string;
}

/** Any model or service that can assess entailment. Provider-neutral. */
export interface Judge {
  /** Recorded in every result, e.g. `anthropic:claude-opus-5-5/prompt-v1`. */
  readonly id: string;
  assess(input: JudgeInput, signal: AbortSignal): Promise<JudgeResult>;
}

const CONTEXT_CHARS = 300;

/**
 * The excerpt shown to the judge: the verified quote plus surrounding
 * context from the evidence it was found in. Undefined when the quote isn't
 * grounded — those claims are not judged.
 */
export function excerptFor(claim: ResolvedClaim, evidence: ReadonlyMap<string, EvidenceRecord>): string | undefined {
  if (!claim.quote) return undefined;
  const quote = normalizeForMatch(claim.quote);
  for (const id of claim.evidence_ids) {
    const content = evidence.get(id)?.content;
    if (!content || !normalizeForMatch(content).includes(quote)) continue;
    // Locate the raw span when possible to include context; fall back to the quote alone.
    const at = content.toLowerCase().indexOf(claim.quote.trim().toLowerCase());
    if (at < 0) return claim.quote;
    const start = Math.max(0, at - CONTEXT_CHARS);
    const end = Math.min(content.length, at + claim.quote.length + CONTEXT_CHARS);
    return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
  }
  return undefined;
}

const outcome = (target: string, status: CheckResult["status"], reason: ReasonCode, message: string): RawResult => ({
  check: "claims.support",
  kind: "probabilistic",
  target,
  status,
  reason,
  message,
});

/** Run a function over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Judge every grounded claim in an envelope. Returns raw results to pass to
 * `verifyRun({ extraResults })`. Never throws on judge failure.
 */
export async function judgeClaims(input: unknown, policy: CompiledPolicy, judge: Judge): Promise<RawResult[]> {
  const settings = policy.semantics;
  if (!settings.enabled) return [];
  let parsed: ReturnType<typeof parseEnvelope>;
  try {
    parsed = parseEnvelope(JSON.parse(JSON.stringify(input ?? null)));
  } catch {
    return [];
  }
  if (!parsed.ok) return []; // envelope.structure already fails the run
  const evidence = new Map((parsed.envelope.evidence ?? []).map((e) => [e.id, e]));

  const claims = parsed.claims.slice(0, settings.maxClaims);
  const skipped = parsed.claims.slice(settings.maxClaims).map((c) =>
    outcome(`claim:${c.id}`, "unknown", "JUDGE_UNAVAILABLE", `Not judged: over the policy's max_claims (${settings.maxClaims}).`),
  );

  const judged = await mapLimit(claims, settings.concurrency, async (claim): Promise<RawResult> => {
    const target = `claim:${claim.id}`;
    const excerpt = excerptFor(claim, evidence);
    if (excerpt === undefined) {
      return outcome(target, "not_applicable", "NOT_APPLICABLE", "Not judged: the claim has no quote grounded in captured evidence.");
    }
    const tag = `${judge.id} · excerpt ${sha256(excerpt).slice(0, 12)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const timeout = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(`timed out after ${settings.timeoutMs} ms`)), { once: true });
      });
      const result = await Promise.race([judge.assess({ claim: claim.text, excerpt }, controller.signal), timeout]);
      const why = result.rationale ? ` ${result.rationale}` : "";
      switch (result.verdict) {
        case "supported":
          return outcome(target, "pass", "OK", `Model assessment (${tag}): supported.${why}`);
        case "unsupported":
          return outcome(target, "fail", "CLAIM_UNSUPPORTED", `Model assessment (${tag}): the excerpt does not support the claim.${why}`);
        default:
          return outcome(target, "unknown", "CLAIM_SUPPORT_UNCLEAR", `Model assessment (${tag}): unclear.${why}`);
      }
    } catch (error) {
      return outcome(target, "unknown", "JUDGE_UNAVAILABLE", `Judge ${judge.id} gave no verdict: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  });
  return [...judged, ...skipped];
}

/** Results for a run where semantic checks are enabled but no judge ran (e.g. CLI replay). */
export function judgeMissing(claims: ResolvedClaim[]): RawResult[] {
  return claims.map((c) => outcome(`claim:${c.id}`, "unknown", "JUDGE_UNAVAILABLE", "Semantic checks are enabled but no judge ran."));
}
