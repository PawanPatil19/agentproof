# AgentProof

**Every answer needs evidence. Every handoff needs a contract.**

AgentProof is a local-first verification layer for AI agents. It checks what
an agent claims against the evidence it captured, validates what one agent
hands to another against an explicit contract, and records *why* a workflow
was allowed to continue in a portable receipt.

> "Verified" always means *passed the recorded checks under a named policy*.
> It never means true or safe. A found quote proves the source contains that
> text — not that the claim follows from it.

Status: v0.1, local v1 slice of the [product handoff](docs/CRITIQUE.md).
Deterministic checks only; no network calls, no accounts.

## See it in 30 seconds

```bash
npm install
npm run demo
```

Five scenarios run through the same gated two-agent workflow
(researcher → writer → person):

| Scenario | What AgentProof does |
| --- | --- |
| Honest researcher | Allows the handoff and the final answer |
| Cites `src-404`, never captured | Blocks, writer requests one repair, attempt 2 passes |
| Quotes a real source that never says it | Blocks with `QUOTE_NOT_FOUND`, repair passes |
| Tries `publish.post` during drafting | Tool blocked *before* it runs; task stops |
| Same, in observe mode | Tool runs, receipt records "would block" |

Receipts and HTML reports land in `examples/research-handoff/out/`.

## CLI

```bash
npm run agentproof -- inspect fixtures/runs/fabricated-quote.json      # diagnose, observe only
npm run agentproof -- init                                             # starter agentproof.yaml
npm run agentproof -- policy validate agentproof.yaml
npm run agentproof -- check fixtures/runs/valid.json --policy fixtures/agentproof.yaml
```

`npm run agentproof --` runs the CLI straight from TypeScript source. For a
real `agentproof` binary, run `npm run build && npm install` (npm links a
workspace bin only once its `dist/` target exists), then use `npx agentproof`.

| Command | Purpose | Exit |
| --- | --- | --- |
| `inspect <run.json>` | Baseline diagnostics, never fails | 0 |
| `check <run.json> --policy f [--mode]` | CI gate | 0 allow · 2 block/review · 3 error |
| `report <receipt.json> [--run run.json]` | Render HTML | 0 |
| `init [--template research-handoff]` | Write a starter policy (observe mode) | 0 |
| `policy validate <file>` | Compile a policy | 0 · 3 |
| `prune [--days 7]` | Delete receipts past retention | 0 |

## SDK

```ts
import { createVerifier, ToolBlockedError } from "@agentproof/sdk";

const proof = await createVerifier({
  policyFile: "./agentproof.yaml",
  identities: { researcher: ["agent://researcher-1"], writer: ["agent://writer-1"] },
});

// Writer issues a contract; the researcher accepts its exact digest.
let contract = proof.issueContract("research_to_writer", {
  taskId: "task-42", worker: "agent://researcher-1", coordinator: "agent://writer-1",
});
contract = proof.acceptContract(contract, { identity: "agent://researcher-1" });

// Every tool call is checked before it runs. Identity comes from the host.
const tools = proof.guardTools(realToolExecutor, contract, { identity: "agent://researcher-1" });
const { output, evidence } = await researcher.run({ tools });

// Gate the handoff before the writer reads it.
const receipt = await proof.verifyCompletion({ contract, output, evidence, identity: "agent://researcher-1" });
if (receipt.decision === "allow") await writer.consume(output);
else if (receipt.decision === "review") await reviewQueue.add(receipt);   // proof.approve(...) binds to this output
else if (canRepair(receipt)) contract = proof.retry(contract);           // bounded, obligations re-pinned
else stop(receipt.reason_codes);

// Gate the final answer again before a person sees it.
const final = await proof.verifyAnswer({ output: answer, evidence });
```

The agent must emit **explicit claims** in `output.claims`:

```json
{ "claims": [{
  "text": "The Pro plan costs $12 per member per month.",
  "quote": "Pricing for the Pro plan is $12 per member per month.",
  "evidence_ids": ["doc-changelog-3-2"],
  "value": { "key": "pro_price", "value": 12, "unit": "USD/member/month" }
}]}
```

The contract's `output_schema` in `agentproof.yaml` doubles as the format
instruction you give the model.

## Policy

```yaml
api_version: agentproof/v1
policy: { id: research-handoff, version: 1 }
mode: enforce                       # or observe
checks:
  evidence:
    require_quote: true             # exact excerpt must appear in cited content
    allowed_source_ids: [product-docs, changelog]
    max_source_age_days: 365
contracts:
  research_to_writer:
    version: 1
    coordinator: writer
    worker: researcher
    deadline_ms: 30000
    allowed_tools: [docs.search, docs.read]
    output_schema: { ... }
enforcement:
  advisory_checks: [evidence.freshness]   # shown, never blocks
```

One rule: a configured check is required; required **fail → block**,
required **unknown → review**, checker crash → block. An output must declare
at least `min_claims` claims (default 1). Boundary-integrity checks can't be
made advisory, and unknown keys are rejected. Full template: `npx agentproof init`.

## Repository

```
packages/core     pure engine: policy, checks, decisions, receipts, HTML report
packages/sdk      runtime gates: contracts, tool guard, approvals, receipt store
packages/cli      agentproof command
examples/         research-handoff two-agent reference app
fixtures/         30 reviewed failure-mode runs + expected outcomes
scripts/          fixture generator, benchmark
docs/             CRITIQUE.md (what changed from the handoff and why), DESIGN.md
```

```bash
npm test          # 109 tests: fixtures, policy, receipts, hardening, SDK lifecycle, enforcement, CLI, end-to-end
npm run bench     # 20 claims, ~1 MB evidence, 1,000 runs → p95 ≈ 33 ms
npm run build     # tsc project references → dist/
```

Requires Node ≥ 22.6 for running from source (`--experimental-strip-types`);
built output runs on Node ≥ 20.11.

## Limits

- A cited source can be wrong. Quote grounding proves presence, not truth.
- v1 checks only explicitly declared claims; omitted claims are unchecked.
- In-process gates assume a trusted host. A compromised app can bypass them.
- Replaying a run with `check` cannot undo actions that already happened.
- Redaction is best-effort pattern matching.

MIT licensed. "AgentProof" is a working name; package and trademark
availability have not been checked.
