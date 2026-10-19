/**
 * Shared vocabulary for AgentProof.
 *
 * Three layers, deliberately kept apart:
 *   1. Inputs  — what the host captured (RunEnvelope: output, claims, evidence, tool events).
 *   2. Results — what each check concluded (CheckResult: pass / fail / unknown / not_applicable).
 *   3. Actions — what the policy decided (Decision: allow / block / review), recorded in a Receipt.
 */

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Where in a workflow the verification happens. */
export type Boundary = "worker_completion" | "final_answer";

/** A numeric value with an optional unit, e.g. `{ value: 4.2, unit: "M USD" }`. */
export interface Quantity {
  value: number;
  unit?: string;
}

/**
 * A material claim declared by the agent. v1 requires explicit claims —
 * AgentProof does not extract them from free text.
 */
export interface Claim {
  /** Stable ID; generated as `c1`, `c2`, … when omitted. */
  id?: string;
  text: string;
  /** IDs of evidence records that support this claim. */
  evidence_ids?: string[];
  /** Exact excerpt the claim relies on. Must appear verbatim in cited evidence content. */
  quote?: string;
  /** Explicit numeric claim, compared against `evidence.values[key]`. */
  value?: Quantity & { key: string };
}

/** A captured source record or tool result the agent relied on. */
export interface EvidenceRecord {
  id: string;
  /** Registered source the record came from, e.g. `product-docs`. */
  source_id?: string;
  /** URL or path. Shown in reports; query strings are stripped from receipts. */
  locator?: string;
  /** Captured body. Used transiently for checks; never written to receipts. */
  content?: string;
  /** Hash of the content at capture time. Verified when content is also present. */
  content_sha256?: string;
  /** Trusted publication / revision date of the source (ISO 8601). */
  published_at?: string;
  revision?: string;
  /** When the host captured the record. Capture time is not source freshness. */
  captured_at?: string;
  /** Structured values for numeric-fidelity checks. */
  values?: Record<string, Quantity>;
}

/** A tool invocation observed at a guarded boundary. */
export interface ToolEvent {
  tool: string;
  /** Trusted runtime identity of the caller (from the host, not the agent). */
  agent: string;
  at?: string;
  /** What the guard did at call time. */
  outcome?: "invoked" | "blocked";
  reason?: string;
  /** Set by the guard when the call violated the contract (even if observe mode let it run). */
  reason_code?: ReasonCode;
}

/** A contract instance as issued to one worker for one attempt. */
export interface ContractInstance {
  name: string;
  version: number;
  /** Digest of the contract definition in the policy. */
  definition_digest: string;
  /** Digest of this instance (definition + task binding). What the worker accepts. */
  digest: string;
  task_id: string;
  attempt_id: string;
  attempt: number;
  parent_attempt_id?: string;
  coordinator: string;
  worker: string;
  issued_at: string;
  deadline_at: string;
  /** Present once the worker accepted. */
  acceptance?: {
    identity: string;
    digest: string;
    at: string;
  };
}

/** The normalized unit of verification. Also the on-disk format of `run.json`. */
export interface RunEnvelope {
  api_version: "agentproof/v1";
  run_id: string;
  task_id?: string;
  boundary?: Boundary;
  /** The deliverable. Claims are read from `output.claims` when it is an object. */
  output: unknown;
  evidence?: EvidenceRecord[];
  tool_events?: ToolEvent[];
  contract?: ContractInstance;
  /** When the output was submitted. Used as the reference time for freshness and deadlines. */
  submitted_at?: string;
  /** Free-form host metadata. Ignored by checks, never copied into receipts. */
  metadata?: Record<string, unknown>;
}

// ── Results ──────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "unknown" | "not_applicable";

/** Deterministic checks are reproducible; probabilistic ones are model assessments. */
export type CheckKind = "deterministic" | "probabilistic";

export type ReasonCode =
  | "OK"
  | "NOT_APPLICABLE"
  | "ENVELOPE_INVALID"
  | "CLAIMS_MISSING"
  | "SCHEMA_INVALID"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_UNKNOWN_ID"
  | "EVIDENCE_EMPTY"
  | "QUOTE_MISSING"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_TOO_SHORT"
  | "QUOTE_CONTENT_UNAVAILABLE"
  | "CONTENT_HASH_MISMATCH"
  | "LOCATOR_MALFORMED"
  | "LOCATOR_UNSAFE"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_STALE"
  | "SOURCE_DATE_MISSING"
  | "NUMERIC_MISMATCH"
  | "NUMERIC_UNIT_MISMATCH"
  | "NUMERIC_VALUE_MISSING"
  | "TOOL_NOT_ALLOWED"
  | "CONTRACT_MISSING"
  | "CONTRACT_UNKNOWN"
  | "CONTRACT_NOT_ACCEPTED"
  | "CONTRACT_DIGEST_MISMATCH"
  | "CONTRACT_POLICY_CHANGED"
  | "CONTRACT_IDENTITY_MISMATCH"
  | "CONTRACT_EXPIRED"
  | "CONTRACT_REPLAY"
  | "CONTRACT_STATE_INVALID"
  | "CLAIM_UNSUPPORTED"
  | "CLAIM_SUPPORT_UNCLEAR"
  | "JUDGE_UNAVAILABLE"
  | "RECEIPT_PERSIST_FAILED"
  | "CHECKER_ERROR";

export interface CheckResult {
  /** Check identifier, e.g. `evidence.quote`. Policies refer to checks by this ID. */
  check: string;
  kind: CheckKind;
  /** What was checked: `claim:c2`, `evidence:src-1`, `tool:docs.read`, `output`, `contract`. */
  target: string;
  status: CheckStatus;
  reason: ReasonCode;
  /** Human-readable explanation, safe to show (never contains evidence bodies). */
  message: string;
  /** Whether this result can influence the decision. Filled in by the engine. */
  required: boolean;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type Decision = "allow" | "block" | "review";
export type Mode = "observe" | "enforce";

export interface Coverage {
  claims_total: number;
  claims_with_evidence: number;
  /** Claims whose required claim-level checks all passed. */
  claims_passing: number;
  checks: Record<CheckStatus, number>;
  tool_events: number;
}

export interface ReceiptClaim {
  id: string;
  /**
   * Salted commitment to the claim text: `hmac-sha256:<hex>`. The salt is
   * kept by the issuer, so the text can't be guessed from the receipt but
   * can be opened to a chosen auditor. See docs/RECEIPT_SPEC.md.
   */
  text_commitment: string;
  /** Only present when `privacy.capture` is `claims`. Redacted. */
  text?: string;
  evidence_ids: string[];
  status: CheckStatus;
}

export interface ReceiptEvidence {
  id: string;
  source_id?: string;
  /** Locator with query string and fragment removed. */
  locator?: string;
  content_sha256?: string;
  published_at?: string;
  revision?: string;
}

export interface Receipt {
  receipt_version: "agentproof.receipt/v2";
  run_id: string;
  task_id?: string;
  boundary: Boundary;
  created_at: string;
  duration_ms: number;
  checker_version: string;
  policy: { id: string; version: number; digest: string };
  contract?: {
    name: string;
    version: number;
    digest: string;
    attempt_id: string;
    attempt: number;
    parent_attempt_id?: string;
    worker: string;
    coordinator: string;
  };
  mode: Mode;
  /** The action the host must take. In observe mode this is always `allow`. */
  decision: Decision;
  /** What the policy concluded, regardless of mode. Equals `decision` in enforce mode. */
  evaluated_decision: Decision;
  /** Reasons behind a non-allow evaluated decision (required failures and unknowns). */
  reason_codes: ReasonCode[];
  coverage: Coverage;
  checks: CheckResult[];
  /** Random per-receipt nonce (32 hex chars) mixed into every claim's salt. */
  commitment_nonce: string;
  claims: ReceiptClaim[];
  evidence: ReceiptEvidence[];
  tool_events: ToolEvent[];
  /** Hash of the output as submitted. Approvals bind to this. */
  output_sha256: string;
  /** sha256 of this receipt's canonical JSON, excluding this field and `signature`. */
  receipt_sha256: string;
  /**
   * Optional Ed25519 signature proving who issued the receipt. It is a DSSE
   * signature over the receipt's in-toto Statement (see signing.ts), so the
   * receipt converts losslessly to a standard DSSE envelope and back.
   */
  signature?: { alg: "ed25519"; key_id: string; value: string };
}
