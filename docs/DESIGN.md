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
| `@agentproof/cli` | `inspect`, `check`, `report`, `init`, `policy validate`, `keys`, `verify-receipt`, `prune` | filesystem |
| `@agentproof/judge-anthropic` | Reference independent judge backed by Claude | network (opt-in) |
| `examples/research-handoff` | Two-agent reference app | — |

Dependencies point one way: `cli → sdk → core`, and `judge-anthropic → core`.
Core never imports a provider SDK. Core has two runtime
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
| `output.claims` | `min_claims` > 0 (default 1) | output declares too few claims | — |
| `output.schema` | contract or `final_answer` declares a schema | schema mismatch | — |
| `evidence.reference` | per claim | no evidence (if required), unknown ID, empty content | — |
| `evidence.quote` | per claim | no quote (if required), quote too short, quote not in cited content | content not captured |
| `evidence.integrity` | cited record has content + hash | hash mismatch | — |
| `evidence.locator` | cited record has a locator | `javascript:`/`data:`/`file:` scheme, malformed URL | — |
| `evidence.source` | `allowed_source_ids` set | source not allowed / missing | — |
| `evidence.freshness` | `max_source_age_days` set | older than limit | no trusted `published_at` |
| `claims.support` | `checks.semantics.enabled` (needs a judge) | judge: excerpt doesn't support the claim | judge unclear, timed out, errored, or none ran |
| `numeric.fidelity` | claim has `value` | value outside tolerance, unit differs | no cited record holds the key |
| `tools.permission` | worker completion with a contract (tools denied unless listed; `["*"]` allows any) | tool not allowed (even if blocked), caller ≠ worker, call made outside the contract's terms (before acceptance, after deadline) even if observe mode let it run | — |
| `contract.binding` | worker completion under a policy with contracts | missing, unknown, policy changed, digest altered, not accepted, wrong acceptor | — |
| `contract.deadline` | worker completion with a contract | submitted after deadline | invalid deadline |
| `contract.lifecycle` | SDK only | replay, superseded attempt, forged submitter, edited contract | — |
| `receipt.persistence` | SDK only | receipt could not be written | — |

"Cited" records are those referenced by at least one claim (all records when
no claim cites any). Freshness and deadlines use the envelope's
`submitted_at`, never wall-clock time, so replays are stable.

All checks are deterministic except `claims.support`, which is marked
`kind: "probabilistic"` and rendered as a model assessment.

## Provider adapters

`fromAnthropicMessage(response, documents)`,
`fromOpenAIResponse(response, sources)` and the provider-neutral
`fromCitedSegments(segments, sources)` turn native citations into claims and
evidence. Each citation becomes one claim, and evidence content comes only
from what the host supplied, never from model output. A citation to a
source the host never supplied stays unresolved and fails
`evidence.reference`. Web-search citations carry no host-captured content,
so their quotes are inconclusive (review) until the host captures the page.

Anthropic citations include `cited_text`, which becomes the claim's quote.
OpenAI annotations (`url_citation`, `file_citation`) mark only positions in
the answer. The adapter reads them by structure, with no SDK dependency, and
splits each `output_text` into segments at the annotation spans. A
`file_citation` marks a single `index`, so its span is the sentence that ends
there. That span becomes the quote only when it reads like an excerpt: at
least two words, not a link, a URL or a bracketed marker. Otherwise the quote
is left undefined and `evidence.require_quote` decides. A span quote only
claims that the source says this. The quote check still searches the
host-supplied content, so a paraphrase fails `QUOTE_NOT_FOUND`. Hosts whose
models paraphrase pass `spanQuotes: false`.

OpenAI citations name sources rather than index them. A `file_citation`
resolves to the supplied source whose `id` or `aliases` contain its
`file_id`, or else the one source whose `aliases` contain its `filename`.
Anything else gets the ID `file:<file_id>`, which no supplied source has, so
it fails `EVIDENCE_UNKNOWN_ID`. A `url_citation` resolves to the source
whose `locator` or `aliases` match the URL, ignoring `utm_*` parameters, the
fragment and a trailing slash. Otherwise it becomes a content-less web
record.

## Independent semantic judge

`judgeClaims(envelope, policy, judge)` runs before `verifyRun` and passes its
results in as `extraResults`. It only judges claims whose quote was already
found verbatim, gives the judge the claim text and about 300 characters of
context around the quote, and nothing else. Concurrency, per-claim timeout
and a claim cap come from `checks.semantics`. Results record the judge ID
(model and prompt version) and the excerpt hash. If semantics are enabled
but no judge ran (a CLI replay, say), every claim gets `JUDGE_UNAVAILABLE`,
so the run goes to review instead of passing silently.

## Decision rule

```
required fail     → enforcement.on_required_check_fail     (default block)
required unknown  → enforcement.on_required_check_unknown  (default review)
CHECKER_ERROR     → enforcement.on_verifier_error          (default block)
advisory_checks   → reported, never decide
most severe wins: block > review > allow
```

A configured check is required. To keep a check visible but non-blocking,
list it in `advisory_checks` — content checks only. Checks that guard the
boundary itself (`envelope.structure`, `contract.*`, `tools.permission`,
`receipt.persistence`) cannot be advisory, and `on_verifier_error` cannot be
`allow`. In observe mode `decision` is always `allow`
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

- **One contract per task and name.** Further attempts only come from
  `retry()`, which refuses while an attempt is still being verified, so the
  repair limit can't be reset and a task never has two live attempts.
- **A contract only counts at a worker boundary.** An envelope that pairs a
  contract with `boundary: final_answer` is invalid.

Inside one process this is integrity and replay protection, not
authentication — a compromised host can bypass any in-process gate. The
same applies to `agentproof check` on a `run.json`: contract digests are
unkeyed, so a replay proves the file is internally consistent, not that this
verifier issued the contract. Only the SDK's ledger knows that.

## Review approvals

`approve()` looks the receipt up among those this verifier issued (by
digest) and decides from its own copy, so an edited and re-sealed receipt is
refused. An approval binds to that receipt and output hash, expires after
`review_timeout_ms`, and is single-use. Blocks cannot be approved.

## Receipts and privacy

A receipt contains IDs, hashes, locators, versions, every check result,
coverage, tool events and the decision, sealed with `receipt_sha256`.

By default it **omits** evidence bodies and claim text (hashes instead),
strips credentials, query strings and fragments from locators of every
scheme (`https`, `s3`, `ftp`, plain paths), and redacts and length-caps every
agent-controlled string — IDs, targets, messages, tool names. Identifiers
are restricted to a plain character set at the envelope boundary. `privacy.capture: claims` adds redacted claim text.
Receipts are written atomically with mode `0600` in a `0700` directory.

A seal detects edits, not tampering: anyone who can rewrite the file can
re-seal it. A **signature** fixes that: Ed25519 over `receipt_sha256`
(which covers every other field), with a key ID derived from the public key.
The signature sits outside the digest, and re-sealing drops a stale one.
`verifyReceiptSignature` checks digest, key ID and signature, in that order.

The HTML report is fully static: no scripts, a CSP that also forbids forms
and `<base>`, every string escaped, class names drawn from fixed sets, links
only for `http(s)` locators. `agentproof report` validates a receipt file
against a schema before rendering it. It can show claim text when
generated from a run file the developer already holds, and says so.

## Performance

`npm run bench` — 20 claims, ~1 MB evidence, 1,000 warm runs. On a 20-thread
i7-13700H with Node 22: p50 ≈ 20 ms, p95 ≈ 33 ms (target: 100 ms on 4 vCPU;
not yet measured on that machine). Input is snapshotted to plain JSON at the
engine boundary, which costs a few ms per MB and buys immutability during
checks.

## Deferred, deliberately

Automatic claim extraction, MCP gateway, OpenTelemetry export, SQLite or
encrypted snapshots, hosted dashboard, signed contracts, Python SDK. The
`ReceiptStore` and `Judge` interfaces are the seams those plug into.
