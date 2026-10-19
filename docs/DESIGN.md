# Design

How AgentProof is put together and why. For what was cut or changed from
the original handoff, see [CRITIQUE.md](CRITIQUE.md).

## The model in one picture

```
 inputs                      results                         action
 ───────────────             ─────────────────────────       ──────────────────
 RunEnvelope   ──checks──▶   CheckResult[]          ──policy──▶  Decision
  output                      pass | fail |                       allow | block | review
  output.claims[]             unknown | not_applicable            (+ observe / enforce)
  evidence[]                  + reason code + message
  tool_events[]                                                ──▶ Receipt (sealed JSON)
  contract                                                     ──▶ HTML report
```

Three layers that never mix:

1. **Inputs** — what the host captured. One format, the *run envelope*, used by
   the SDK in memory and by the CLI as `run.json`.
2. **Results** — what each check concluded. A check never decides anything.
3. **Actions** — what the policy decided. Mode only changes whether the host
   must honor it.

## Packages

| Package | Role | I/O |
| --- | --- | --- |
| `@agentproof/core` | Envelope parsing, policy compiler, checks, decision engine, receipts, HTML report | none (pure, apart from a clock) |
| `@agentproof/sdk` | Runtime gates: contract ledger, tool guard, completion & answer gates, approvals, receipt store | filesystem (receipts) |
| `@agentproof/cli` | `inspect`, `check`, `report`, `init`, `policy validate`, `prune` | filesystem |
| `examples/research-handoff` | Two-agent reference app | — |

Dependencies point one way: `cli → sdk → core`. Core has two runtime
dependencies (`ajv`, `yaml`, plus `ajv-formats`).

### Core layout

```
packages/core/src/
  types.ts            the whole vocabulary — start reading here
  envelope.ts         validate + normalize a run envelope, extract claims
  policy/
    schema.ts         JSON Schema for agentproof.yaml (closed objects)
    compile.ts        YAML → CompiledPolicy; cross-reference validation; digests
    presets.ts        baseline preset, research-handoff template
  checks/
    context.ts        CheckContext, result helpers
    ids.ts            every check ID
    index.ts          the ordered check list
    evidence.ts       reference, quote, integrity, locator, source, freshness
    numeric.ts        numeric fidelity
    output.ts         output schema
    tools.ts          tool permissions
    contract.ts       contract binding, deadline
  decide.ts           results → decision (the one rule)
  receipt.ts          build, seal, amend receipts
  verify.ts           verifyRun(): the entry point
  contract.ts         contract instance digest
  report/             HTML report + plain-language reason text
  util/               hashing, text normalization/redaction, ajv setup
```

**Adding a check** = write a pure `(ctx) => RawResult[]` function, add its ID
to `checks/ids.ts`, list it in `checks/index.ts`, add a reason code, add a
fixture. Nothing else changes.

## Checks

All v1 checks are deterministic. Each decides for itself whether it applies.

| ID | Runs when | Fails on | Unknown on |
| --- | --- | --- | --- |
| `envelope.structure` | always | invalid envelope | input could not be read |
| `output.schema` | contract or `final_answer` declares a schema | schema mismatch | — |
| `evidence.reference` | per claim | no evidence (if required), unknown ID, empty content | — |
| `evidence.quote` | per claim | no quote (if required), quote too short, quote not in cited content | content not captured |
| `evidence.integrity` | cited record has content + hash | hash mismatch | — |
| `evidence.locator` | cited record has a locator | `javascript:`/`data:`/`file:` scheme, malformed URL | — |
| `evidence.source` | `allowed_source_ids` set | source not allowed / missing | — |
| `evidence.freshness` | `max_source_age_days` set | older than limit | no trusted `published_at` |
| `numeric.fidelity` | claim has `value` | value outside tolerance, unit differs | no cited record holds the key |
| `tools.permission` | contract has `allowed_tools` | tool not allowed (even if blocked), caller ≠ worker | — |
| `contract.binding` | worker completion under a policy with contracts | missing, unknown, policy changed, digest altered, not accepted, wrong acceptor | — |
| `contract.deadline` | worker completion with a contract | submitted after deadline | invalid deadline |
| `contract.lifecycle` | SDK only | replay, superseded attempt, forged submitter, edited contract | — |
| `receipt.persistence` | SDK only | receipt could not be written | — |

"Cited" records are those referenced by at least one claim (all records when
no claim cites any). Freshness and deadlines use the envelope's
`submitted_at`, never wall-clock time, so replays are stable.

## Decision rule

```
required fail     → enforcement.on_required_check_fail     (default block)
required unknown  → enforcement.on_required_check_unknown  (default review)
CHECKER_ERROR     → enforcement.on_verifier_error          (default block)
advisory_checks   → reported, never decide
most severe wins: block > review > allow
```

A configured check is required. To keep a check visible but non-blocking,
list it in `advisory_checks`. In observe mode `decision` is always `allow`
and `evaluated_decision` holds what enforcement would have done.

The engine never throws on input and never fails open: an unreadable
envelope or a crashing check produces `CHECKER_ERROR`.

## Contracts

```
proposed → accepted → running → submitted → validated | rejected
                                          ↘ superseded (retried)
```

- **Definition digest** pins the obligations in the policy. Editing the policy
  after issue → `CONTRACT_POLICY_CHANGED`.
- **Instance digest** binds definition + task + attempt + identities + deadline.
  The worker accepts *this* digest; editing any term afterwards →
  `CONTRACT_DIGEST_MISMATCH`.
- **The ledger copy is authoritative.** The SDK compares whatever contract the
  caller hands back against the one it issued.
- **Retries** get a new attempt ID, link to the parent, re-pin the same
  definition (obligations can't weaken), and are capped by
  `max_repair_attempts`.
- **Identity** comes from the host: `guardTools(executor, contract, { identity })`
  binds it in a closure. `identities` in `createVerifier` maps logical agent
  names to allowed runtime identities.

Inside one process this is integrity and replay protection, not
authentication — a compromised host can bypass any in-process gate.

## Receipts and privacy

A receipt contains IDs, hashes, locators, versions, every check result,
coverage, tool events and the decision, sealed with `receipt_sha256`.

By default it **omits** evidence bodies and claim text (hashes instead),
strips URL credentials/query/fragment, and redacts known secret formats in
anything textual. `privacy.capture: claims` adds redacted claim text.
Receipts are written atomically with mode `0600` in a `0700` directory.

A seal detects edits, not tampering: anyone who can rewrite the file can
re-seal it. Signed receipts are future work.

The HTML report is fully static: no scripts, a restrictive CSP, every string
escaped, links only for `http(s)` locators. It can show claim text when
generated from a run file the developer already holds, and says so.

## Performance

`npm run bench` — 20 claims, ~1 MB evidence, 1,000 warm runs. On a 20-thread
i7-13700H with Node 22: p50 ≈ 20 ms, p95 ≈ 33 ms (target: 100 ms on 4 vCPU;
not yet measured on that machine). Input is snapshotted to plain JSON at the
engine boundary, which costs a few ms per MB and buys immutability during
checks.

## Deferred, deliberately

Semantic (model) judging, automatic claim extraction, MCP gateway,
OpenTelemetry export, SQLite / encrypted snapshots, hosted dashboard, signed
receipts, Python SDK. The `ReceiptStore` interface and the `kind:
"probabilistic"` result field are the seams those plug into.
