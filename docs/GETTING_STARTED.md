# Getting started

From clone to your first receipt in about ten minutes. Everything here runs
offline: no account, no API key, no network calls.

**Needs:** Node.js 22.6 or newer, npm, git.

## 1. Install (1 minute)

```bash
git clone https://github.com/PawanPatil19/agentproof.git
cd agentproof
npm install
```

## 2. Watch the gate work (1 minute)

```bash
npm run demo
```

Five scenarios run through the same researcher → writer workflow. The one to
look at is scenario 4: the researcher tries `publish.post` during a drafting
task, and the tool is refused before it runs. Reports land in
`examples/research-handoff/out/`; open any `.html` file in a browser.

## 3. Diagnose a run (2 minutes)

A *run* is one JSON file: the agent's output, the claims it makes, and the
evidence it captured.

```bash
npm run agentproof -- inspect fixtures/runs/fabricated-quote.json
```

`inspect` never blocks; it shows what *would* be blocked and writes a receipt
plus an HTML report to `agentproof-reports/`. Open
`agentproof-reports/latest.html`.

## 4. Write your own run (3 minutes)

Save this as `my-run.json`:

```json
{
  "api_version": "agentproof/v1",
  "run_id": "my-first-run",
  "boundary": "final_answer",
  "output": {
    "text": "The Pro plan costs $12 per member per month.",
    "claims": [
      {
        "text": "The Pro plan costs $12 per member per month.",
        "quote": "Pricing for the Pro plan is $12 per member per month.",
        "evidence_ids": ["pricing"]
      }
    ]
  },
  "evidence": [
    {
      "id": "pricing",
      "source_id": "product-docs",
      "locator": "https://example.com/pricing",
      "published_at": "2026-09-01",
      "content": "Pricing for the Pro plan is $12 per member per month."
    }
  ]
}
```

```bash
npm run agentproof -- inspect my-run.json
```

Now break it: change the quote to `"Pricing is $10."` and run it again. The
quote check fails because the evidence never says that.

> Already using a provider's native citations? Skip writing claims by hand:
> `fromAnthropicMessage(response, documents)` builds the claims and evidence
> for you (see the README).

## 5. Enforce a policy (2 minutes)

```bash
npm run agentproof -- init                      # writes agentproof.yaml (observe mode)
npm run agentproof -- policy validate agentproof.yaml
npm run agentproof -- check my-run.json --policy agentproof.yaml --mode enforce
echo "exit code: $?"                            # 0 allow · 2 block/review · 3 error
```

The starter policy only accepts evidence from the sources it lists
(`product-docs`, `changelog`). Remove `"source_id"` from `my-run.json` and
check again to see `SOURCE_NOT_ALLOWED`. Read `agentproof.yaml` top to bottom;
every line is commented. Switch `mode`
to `enforce` once the would-be decisions in observe mode look right.

## 6. Put it in your code

```ts
import { createVerifier } from "@agentproof/sdk";

const proof = await createVerifier({ policyFile: "./agentproof.yaml" });
const receipt = await proof.verifyAnswer({ output, evidence });
if (receipt.decision !== "allow") {
  // don't show the answer: block, or send it to review
}
```

For agent-to-agent handoffs (contracts, tool guards, retries), follow
`examples/research-handoff/src/workflow.ts`. It is about 120 lines and
covers all three gates.

## 7. Optional: prove who issued a receipt

```bash
npm run agentproof -- keys generate --out keys
npm run agentproof -- check my-run.json --policy agentproof.yaml --sign-key keys/agentproof-signing.key
npm run agentproof -- verify-receipt agentproof-reports/my-first-run.json --public-key keys/agentproof-signing.pub
```

Share only the `.pub` file. A counterparty can now verify your receipts
without trusting the channel they came through.

## What to read next

- [DESIGN.md](DESIGN.md): how checks, decisions, contracts and receipts work
- [CRITIQUE.md](CRITIQUE.md): what this is for, and what it deliberately is not
