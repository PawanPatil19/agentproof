/**
 * Regenerates fixtures/runs/*.json and fixtures/expectations.json.
 *
 *   node --experimental-strip-types --conditions=source scripts/make-fixtures.ts
 *
 * Each fixture is one failure mode from the handoff's acceptance criteria.
 * Contracts are built with the real digest functions so only the intended
 * defect differs from a valid run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  contractInstanceDigest,
  parsePolicy,
  sha256,
  type ContractInstance,
  type ReasonCode,
  type RunEnvelope,
} from "@agentproof/core";

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const policy = parsePolicy(await readFile(root("fixtures/agentproof.yaml"), "utf8"));
const definition = policy.contracts.get("research_to_writer")!;

const WORKER = "agent://researcher-1";
const COORDINATOR = "agent://writer-1";
const ISSUED = "2026-10-19T10:00:00.000Z";
const DEADLINE = "2026-10-19T10:00:30.000Z";
const SUBMITTED = "2026-10-19T10:00:05.000Z";

function contract(overrides: Partial<ContractInstance> = {}, accept = true): ContractInstance {
  const terms = {
    name: "research_to_writer",
    version: 1,
    definition_digest: definition.definitionDigest,
    task_id: "task-42",
    attempt_id: "att-0001",
    attempt: 1,
    coordinator: COORDINATOR,
    worker: WORKER,
    issued_at: ISSUED,
    deadline_at: DEADLINE,
  };
  const digest = contractInstanceDigest(terms);
  return {
    ...terms,
    digest,
    ...(accept ? { acceptance: { identity: WORKER, digest, at: "2026-10-19T10:00:01.000Z" } } : {}),
    ...overrides,
  };
}

const DOCS = {
  capabilities:
    "Lumen Notes 3.2 supports offline sync on iOS and Android. Exports are available as PDF and Markdown. " +
    "Team workspaces allow up to 50 members on the Pro plan.",
  changelog:
    "Version 3.2 shipped on 12 August 2026. Offline sync is now generally available. " +
    "Pricing for the Pro plan is $12 per member per month.",
};

function evidence() {
  return [
    {
      id: "doc-capabilities",
      source_id: "product-docs",
      locator: "https://docs.lumen.example/capabilities?session=abc123",
      content: DOCS.capabilities,
      content_sha256: sha256(DOCS.capabilities),
      published_at: "2026-08-14",
      captured_at: "2026-10-19T10:00:02.000Z",
    },
    {
      id: "doc-changelog-3-2",
      source_id: "changelog",
      locator: "https://lumen.example/changelog/3.2",
      content: DOCS.changelog,
      content_sha256: sha256(DOCS.changelog),
      published_at: "2026-08-12",
      captured_at: "2026-10-19T10:00:03.000Z",
      values: { pro_price: { value: 12, unit: "USD/member/month" } },
    },
  ];
}

function claims() {
  return [
    { id: "c1", text: "Offline sync is generally available as of version 3.2.", quote: "Offline sync is now generally available.", evidence_ids: ["doc-changelog-3-2"] },
    { id: "c2", text: "Notes can be exported to PDF and Markdown.", quote: "Exports are available as PDF and Markdown.", evidence_ids: ["doc-capabilities"] },
    {
      id: "c3",
      text: "The Pro plan costs $12 per member per month.",
      quote: "Pricing for the Pro plan is $12 per member per month.",
      evidence_ids: ["doc-changelog-3-2"],
      value: { key: "pro_price", value: 12, unit: "USD/member/month" },
    },
  ];
}

function valid(): RunEnvelope & { output: { claims: ReturnType<typeof claims> } } {
  return {
    api_version: "agentproof/v1",
    run_id: "fx-valid",
    task_id: "task-42",
    boundary: "worker_completion",
    output: { claims: claims() },
    evidence: evidence(),
    tool_events: [
      { tool: "docs.search", agent: WORKER, at: "2026-10-19T10:00:02.000Z", outcome: "invoked" },
      { tool: "docs.read", agent: WORKER, at: "2026-10-19T10:00:02.500Z", outcome: "invoked" },
    ],
    contract: contract(),
    submitted_at: SUBMITTED,
  };
}

type Fixture = { run: unknown; decision: "allow" | "block" | "review"; reasons: ReasonCode[]; note: string };
const fixtures: Record<string, Fixture> = {};
const add = (name: string, note: string, decision: Fixture["decision"], reasons: ReasonCode[], mutate: (r: ReturnType<typeof valid>) => unknown = (r) => r) => {
  const run = valid();
  run.run_id = `fx-${name}`;
  fixtures[name] = { run: mutate(run) ?? run, decision, reasons, note };
};

add("valid", "Every obligation met.", "allow", []);
add("missing-evidence-id", "Claim cites src-404, which was never captured.", "block", ["EVIDENCE_UNKNOWN_ID"], (r) => {
  r.output.claims[1]!.evidence_ids = ["src-404"];
});
add("claim-without-evidence", "Claim cites nothing; schema and evidence policy both object.", "block", ["SCHEMA_INVALID", "EVIDENCE_MISSING"], (r) => {
  r.output.claims[1]!.evidence_ids = [];
});
add("fabricated-quote", "Real source, plausible quote, the source never says it.", "block", ["QUOTE_NOT_FOUND"], (r) => {
  r.output.claims[0] = { id: "c1", text: "Offline sync launched in June 2026.", quote: "Offline sync launched in June 2026.", evidence_ids: ["doc-changelog-3-2"] };
});
add("short-quote", "A two-word quote cannot ground a claim.", "block", ["QUOTE_TOO_SHORT"], (r) => {
  r.output.claims[0]!.quote = "Offline";
});
add("empty-evidence", "Cited record captured with empty content.", "block", ["EVIDENCE_EMPTY", "QUOTE_NOT_FOUND"], (r) => {
  r.evidence![0]!.content = "  ";
  r.evidence![0]!.content_sha256 = sha256("  ");
});
add("content-tampered", "Content edited after capture; hash no longer matches.", "block", ["CONTENT_HASH_MISMATCH"], (r) => {
  r.evidence![1]!.content = DOCS.changelog.replace("$12", "$9");
  r.output.claims.pop();
});
add("content-not-captured", "Only references were captured, so quotes cannot be checked.", "review", ["QUOTE_CONTENT_UNAVAILABLE"], (r) => {
  for (const e of r.evidence!) delete (e as { content?: string }).content;
});
add("schema-invalid", "Output carries a field the contract does not allow.", "block", ["SCHEMA_INVALID"], (r) => {
  (r.output as Record<string, unknown>).confidence = 0.97;
});
add("numeric-mismatch", "Narrative number differs from the captured value.", "block", ["NUMERIC_MISMATCH"], (r) => {
  r.output.claims[2]!.value!.value = 15;
});
add("unit-mismatch", "Same number, different unit.", "block", ["NUMERIC_UNIT_MISMATCH"], (r) => {
  r.output.claims[2]!.value!.unit = "EUR/member/month";
});
add("numeric-value-missing", "Numeric claim cites a record with no structured value.", "review", ["NUMERIC_VALUE_MISSING"], (r) => {
  r.output.claims[2]!.value!.key = "enterprise_price";
});
add("stale-source", "Source is two years old; freshness is advisory, so it is shown but allowed.", "allow", [], (r) => {
  r.evidence![0]!.published_at = "2024-06-01";
});
add("source-date-missing", "No publication date; advisory unknown.", "allow", [], (r) => {
  delete (r.evidence![0] as { published_at?: string }).published_at;
});
add("disallowed-source", "Evidence from a source outside the allowlist.", "block", ["SOURCE_NOT_ALLOWED"], (r) => {
  r.evidence![0]!.source_id = "random-blog";
});
add("unsafe-locator", "A javascript: locator would be an XSS vector in any report.", "block", ["LOCATOR_UNSAFE"], (r) => {
  r.evidence![0]!.locator = "javascript:alert(document.cookie)";
});
add("unauthorized-tool", "Worker tried publish.post; the guard blocked it before invocation.", "block", ["TOOL_NOT_ALLOWED"], (r) => {
  r.tool_events!.push({ tool: "publish.post", agent: WORKER, at: "2026-10-19T10:00:04.000Z", outcome: "blocked" });
});
add("foreign-tool-caller", "A tool call under this contract came from another agent.", "block", ["CONTRACT_IDENTITY_MISMATCH"], (r) => {
  r.tool_events![1]!.agent = "agent://intruder";
});
add("expired", "Submitted after the deadline.", "block", ["CONTRACT_EXPIRED"], (r) => {
  r.submitted_at = "2026-10-19T10:01:00.000Z";
});
add("not-accepted", "Worker never accepted the contract.", "block", ["CONTRACT_NOT_ACCEPTED"], (r) => {
  r.contract = contract({}, false);
});
add("accepted-other-digest", "Worker accepted a different digest.", "block", ["CONTRACT_DIGEST_MISMATCH"], (r) => {
  r.contract = contract();
  r.contract.acceptance!.digest = `sha256:${"0".repeat(64)}`;
});
add("deadline-extended", "Deadline edited after issue; instance digest breaks.", "block", ["CONTRACT_DIGEST_MISMATCH"], (r) => {
  r.contract = { ...contract(), deadline_at: "2026-10-19T11:00:00.000Z" };
});
add("acceptance-by-other", "Accepted by an identity that is not the worker.", "block", ["CONTRACT_IDENTITY_MISMATCH"], (r) => {
  r.contract!.acceptance!.identity = "agent://writer-1";
});
add("policy-changed", "Contract issued under different obligations than the current policy.", "block", ["CONTRACT_POLICY_CHANGED"], (r) => {
  r.contract = contract({ definition_digest: `sha256:${"a".repeat(64)}` });
});
add("missing-contract", "Worker completion without a contract.", "block", ["CONTRACT_MISSING"], (r) => {
  delete r.contract;
});
add("invalid-envelope", "Not a valid envelope (misspelt field).", "block", ["ENVELOPE_INVALID"], (r) => {
  const { evidence: ev, ...rest } = r;
  return { ...rest, evidense: ev };
});
add("secret-in-claim", "Valid run whose claim text contains a secret; receipts must not leak it.", "allow", [], (r) => {
  r.output.claims[0]!.text += " (debug key sk-live_ABCDEFGHIJKLMNOPQRSTUVWX)";
});

await mkdir(root("fixtures/runs"), { recursive: true });
const expectations: Record<string, Omit<Fixture, "run">> = {};
for (const [name, { run, ...expect }] of Object.entries(fixtures)) {
  await writeFile(root(`fixtures/runs/${name}.json`), `${JSON.stringify(run, null, 2)}\n`);
  expectations[name] = expect;
}
await writeFile(root("fixtures/expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`);
console.log(`wrote ${Object.keys(fixtures).length} fixtures`);
