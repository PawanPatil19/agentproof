/**
 * The engine entry point: envelope in, sealed receipt out.
 * Pure apart from the clock — no network, no filesystem.
 */
import type { Boundary, CheckResult, Mode, Receipt } from "./types.ts";
import type { CompiledPolicy } from "./policy/compile.ts";
import { CHECKS, type CheckContext, type RawResult } from "./checks/index.ts";
import { markRequired } from "./decide.ts";
import { parseEnvelope } from "./envelope.ts";
import { buildReceipt } from "./receipt.ts";
import { commitmentKeyBytes, type CommitmentKey } from "./commitment.ts";
import { judgeMissing } from "./semantics.ts";

export interface VerifyOptions {
  policy: CompiledPolicy;
  /** Overrides the policy's mode, e.g. `--mode enforce` on the CLI. */
  mode?: Mode;
  /** Verifier clock. Freshness and deadlines prefer the envelope's `submitted_at`. */
  now?: () => Date;
  /** Results produced outside the engine, e.g. SDK lifecycle checks. */
  extraResults?: RawResult[];
  /** Secret for salted claim commitments; keep it to open claims to an auditor later. */
  commitmentKey?: CommitmentKey;
}

export function verifyRun(input: unknown, options: VerifyOptions): Receipt {
  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const { policy } = options;
  const mode = options.mode ?? policy.mode;
  // A bad commitment key is a configuration error: fail on every call, not only on runs with claims.
  if (options.commitmentKey !== undefined) commitmentKeyBytes(options.commitmentKey);

  const rejectEnvelope = (status: "fail" | "unknown", reason: "ENVELOPE_INVALID" | "CHECKER_ERROR", message: string): Receipt => {
    const runId = safeRunId(input);
    const results = markRequired([{ check: "envelope.structure", kind: "deterministic", target: "envelope", status, reason, message }], policy);
    return buildReceipt({
      runId, boundary: "final_answer", policy, mode, results, claims: [], evidence: [], toolEvents: [],
      output: null, createdAt: now(), durationMs: performance.now() - started, commitmentKey: options.commitmentKey,
    });
  };

  // The engine never throws on input: hostile or broken envelopes fail closed.
  let parsed: ReturnType<typeof parseEnvelope>;
  try {
    // Snapshot to plain JSON: drops `undefined` fields from JS callers, turns
    // Dates into strings, and freezes the input against mutation mid-check.
    input = JSON.parse(JSON.stringify(input ?? null));
    parsed = parseEnvelope(input);
  } catch (error) {
    return rejectEnvelope("unknown", "CHECKER_ERROR", `Envelope could not be read: ${(error as Error).message}`);
  }
  if (!parsed.ok) return rejectEnvelope("fail", "ENVELOPE_INVALID", `Run envelope is invalid: ${parsed.problems}.`);

  const { envelope, claims } = parsed;
  const boundary: Boundary = envelope.boundary ?? (envelope.contract ? "worker_completion" : "final_answer");
  const evidence = new Map((envelope.evidence ?? []).map((e) => [e.id, e]));
  const citedIds = new Set(claims.flatMap((c) => c.evidence_ids));
  const cited = citedIds.size > 0 ? [...evidence.values()].filter((e) => citedIds.has(e.id)) : [...evidence.values()];
  const submitted = envelope.submitted_at ? new Date(envelope.submitted_at) : undefined;

  const ctx: CheckContext = {
    envelope, boundary, policy, claims, evidence, cited,
    referenceTime: submitted && !Number.isNaN(submitted.getTime()) ? submitted : now(),
  };

  const raw: RawResult[] = [];
  for (const { id, run } of CHECKS) {
    try {
      raw.push(...run(ctx));
    } catch (error) {
      // A crashing check must never read as a pass.
      raw.push({ check: id, kind: "deterministic", target: "engine", status: "unknown", reason: "CHECKER_ERROR", message: `Check crashed: ${(error as Error).message}` });
    }
  }
  raw.push(...(options.extraResults ?? []));
  // Semantic checks enabled but nothing judged (e.g. a CLI replay): say so, don't pass silently.
  if (policy.semantics.enabled && !raw.some((r) => r.check === "claims.support")) raw.push(...judgeMissing(claims));
  const results: CheckResult[] = markRequired(raw, policy);

  return buildReceipt({
    runId: envelope.run_id, taskId: envelope.task_id, boundary, policy, mode, results, claims,
    evidence: envelope.evidence ?? [], toolEvents: envelope.tool_events ?? [], contract: envelope.contract,
    output: envelope.output, createdAt: now(), durationMs: performance.now() - started,
    commitmentKey: options.commitmentKey,
  });
}

function safeRunId(input: unknown): string {
  try {
    const id = (input as { run_id?: unknown })?.run_id;
    return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : "invalid-envelope";
  } catch {
    return "invalid-envelope";
  }
}
