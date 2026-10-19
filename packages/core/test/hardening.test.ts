// Regression tests for the advisor review: each block pins one hole closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  baselinePolicy,
  compilePolicy,
  hashOutput,
  parsePolicy,
  parseReceipt,
  PolicyError,
  renderReport,
  sanitizeLocator,
  seal,
  templatePolicy,
  verifyRun,
} from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const policy = parsePolicy(readFileSync(new URL("agentproof.yaml", fixtures), "utf8"));
const run = (name: string) => JSON.parse(readFileSync(new URL(`runs/${name}.json`, fixtures), "utf8"));
const answer = (output: unknown) => ({ api_version: "agentproof/v1", run_id: "a", boundary: "final_answer", output });

describe("finding 1: an answer with no claims is not verified", () => {
  for (const [label, output] of [["plain string", "Trust me."], ["empty claims", { claims: [] }], ["no claims key", { text: "hi" }]] as const) {
    it(`${label} fails output.claims under baseline and the template`, () => {
      for (const p of [baselinePolicy(), templatePolicy("research-handoff")]) {
        const r = verifyRun(answer(output), { policy: p, mode: "enforce" });
        assert.equal(r.decision, "block");
        assert.ok(r.reason_codes.includes("CLAIMS_MISSING"), `${p.id}: ${r.reason_codes}`);
      }
    });
  }

  it("min_claims: 0 opts out explicitly", () => {
    const p = compilePolicy({ api_version: "agentproof/v1", policy: { id: "p", version: 1 }, checks: { evidence: { min_claims: 0 } } });
    assert.equal(verifyRun(answer("hi"), { policy: p, mode: "enforce" }).decision, "allow");
  });
});

describe("finding 3: contracts cannot be relabelled away", () => {
  it("a contract under boundary final_answer is an invalid envelope", () => {
    const r = verifyRun(run("contract-at-final-answer"), { policy, mode: "enforce" });
    assert.deepEqual(r.reason_codes, ["ENVELOPE_INVALID"]);
  });
});

describe("finding 4: integrity checks cannot be demoted", () => {
  for (const check of ["envelope.structure", "contract.lifecycle", "contract.binding", "tools.permission", "receipt.persistence"]) {
    it(`rejects advisory '${check}'`, () => {
      assert.throws(
        () => compilePolicy({ api_version: "agentproof/v1", policy: { id: "p", version: 1 }, enforcement: { advisory_checks: [check] } }),
        (e: PolicyError) => e.issues.some((i) => i.message.includes("cannot be advisory")),
      );
    });
  }

  it("rejects on_verifier_error: allow", () => {
    assert.throws(() => compilePolicy({ api_version: "agentproof/v1", policy: { id: "p", version: 1 }, enforcement: { on_verifier_error: "allow" } }), PolicyError);
  });
});

describe("finding 5: receipts do not leak", () => {
  it("strips credentials, queries and fragments from every scheme", () => {
    assert.equal(sanitizeLocator("s3://bucket/key.pdf?X-Amz-Signature=deadbeef"), "s3://bucket/key.pdf");
    assert.equal(sanitizeLocator("ftp://user:hunter2@files.example/doc.txt"), "ftp://files.example/doc.txt");
    assert.equal(sanitizeLocator("/docs/report?api_key=abc#p3"), "/docs/report");
  });

  it("redacts secrets planted in identifiers and numeric keys", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const input = run("valid");
    input.output.claims[0].id = token;
    input.evidence[1].id = `doc-${token}`;
    input.output.claims[0].evidence_ids = [`doc-${token}`];
    input.output.claims[2].evidence_ids = [`doc-${token}`];
    input.evidence[0].locator = "s3://bucket/x?X-Amz-Signature=secret-sig";
    const json = JSON.stringify(verifyRun(input, { policy }));
    assert.doesNotMatch(json, /ghp_abcdef/);
    assert.doesNotMatch(json, /secret-sig/);
  });

  it("rejects identifiers that could carry markup", () => {
    const input = run("valid");
    input.output.claims[0].id = `<img src=x onerror=alert(1)>`;
    assert.deepEqual(verifyRun(input, { policy }).reason_codes, ["ENVELOPE_INVALID"]);
  });
});

describe("finding 6: hostile receipts cannot inject into reports", () => {
  const hostile = () => {
    const r = verifyRun(run("valid"), { policy }) as unknown as Record<string, any>;
    r.claims[0].status = `pass"><meta http-equiv="refresh" content="0;url=https://evil.example">`;
    r.evaluated_decision = `allow"><form action="https://evil.example">`;
    r.coverage.claims_total = `<form action="https://evil.example">`;
    return r;
  };

  it("parseReceipt rejects them", () => {
    const parsed = parseReceipt(hostile());
    assert.equal(parsed.ok, false);
    assert.equal(parseReceipt(verifyRun(run("valid"), { policy })).ok, true);
  });

  it("the renderer escapes them even if called directly", () => {
    const html = renderReport(hostile() as never);
    assert.doesNotMatch(html, /<meta http-equiv="refresh"/);
    assert.doesNotMatch(html, /<form/);
    assert.match(html, /form-action 'none'/);
  });
});

describe("output hashing", () => {
  it("hashes Dates by value, like JSON", () => {
    assert.notEqual(hashOutput({ at: new Date("2026-01-01") }), hashOutput({ at: new Date("2027-01-01") }));
    assert.equal(hashOutput({ at: new Date("2026-01-01T00:00:00.000Z") }), hashOutput({ at: "2026-01-01T00:00:00.000Z" }));
  });

  it("re-sealing an edited receipt yields a different digest", () => {
    const r = verifyRun(run("valid"), { policy });
    assert.notEqual(seal({ ...r, decision: "block" }).receipt_sha256, r.receipt_sha256);
  });
});

describe("tools are denied by default", () => {
  const doc = (allowed?: string[]) => ({
    api_version: "agentproof/v1",
    policy: { id: "p", version: 1 },
    contracts: { c: { version: 1, coordinator: "a", worker: "b", deadline_ms: 1000, ...(allowed ? { allowed_tools: allowed } : {}) } },
  });

  it("a contract without allowed_tools permits nothing; '*' permits anything", () => {
    assert.deepEqual([...(compilePolicy(doc()).contracts.get("c")!.allowedTools as Set<string>)], []);
    assert.equal(compilePolicy(doc(["*"])).contracts.get("c")!.allowedTools, "any");
    assert.throws(() => compilePolicy(doc(["*", "docs.read"])), PolicyError);
  });
});
