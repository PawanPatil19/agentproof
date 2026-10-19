import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePolicy, parsePolicy, PolicyError, RESEARCH_HANDOFF_TEMPLATE, templatePolicy, baselinePolicy } from "@agentproof/core";

const base = { api_version: "agentproof/v1", policy: { id: "p", version: 1 } };

function issues(doc: unknown): string {
  try {
    compilePolicy(doc);
  } catch (error) {
    assert.ok(error instanceof PolicyError);
    return error.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
  }
  assert.fail("expected the policy to be rejected");
}

describe("policy compiler", () => {
  it("compiles the bundled template and baseline", () => {
    const p = templatePolicy("research-handoff");
    assert.equal(p.id, "research-handoff");
    assert.equal(p.mode, "observe");
    assert.ok(p.contracts.get("research_to_writer")?.validateOutput);
    assert.equal(baselinePolicy().mode, "observe");
  });

  it("defaults to observe mode and safe enforcement", () => {
    const p = compilePolicy(base);
    assert.equal(p.mode, "observe");
    assert.equal(p.enforcement.onFail, "block");
    assert.equal(p.enforcement.onUnknown, "review");
    assert.equal(p.enforcement.onVerifierError, "block");
    assert.equal(p.privacy.capture, "hashes");
  });

  it("rejects unknown keys anywhere", () => {
    assert.match(issues({ ...base, checks: { evidence: { require_sources: true } } }), /require_sources/);
    assert.match(issues({ ...base, mode: "strict" }), /\/mode/);
  });

  it("rejects unresolved registry references", () => {
    const out = issues({
      ...base,
      registry: { tools: ["docs.read"], sources: ["docs"] },
      checks: { evidence: { allowed_source_ids: ["wiki"] } },
      contracts: { c: { version: 1, coordinator: "a", worker: "b", deadline_ms: 10, allowed_tools: ["shell.exec"] } },
    });
    assert.match(out, /source 'wiki' is not in registry.sources/);
    assert.match(out, /tool 'shell.exec' is not in registry.tools/);
  });

  it("rejects output schemas with unknown keywords", () => {
    const out = issues({ ...base, contracts: { c: { version: 1, coordinator: "a", worker: "b", deadline_ms: 10, output_schema: { type: "object", requird: ["x"] } } } });
    assert.match(out, /output_schema/);
  });

  it("rejects a contract whose coordinator is its worker", () => {
    assert.match(issues({ ...base, contracts: { c: { version: 1, coordinator: "a", worker: "a", deadline_ms: 10 } } }), /different agents/);
  });

  it("rejects unknown advisory checks", () => {
    assert.match(issues({ ...base, enforcement: { advisory_checks: ["evidence.vibes"] } }), /unknown check 'evidence.vibes'/);
  });

  it("rejects duplicate YAML keys", () => {
    assert.throws(() => parsePolicy("api_version: agentproof/v1\npolicy: {id: p, version: 1}\nmode: observe\nmode: enforce\n"), PolicyError);
  });

  it("digests are independent of key order and change with content", () => {
    const a = compilePolicy({ policy: { version: 1, id: "p" }, api_version: "agentproof/v1" });
    const b = compilePolicy(base);
    assert.equal(a.digest, b.digest);
    assert.notEqual(compilePolicy({ ...base, mode: "enforce" }).digest, b.digest);
  });

  it("changing a contract changes its definition digest", () => {
    const original = parsePolicy(RESEARCH_HANDOFF_TEMPLATE).contracts.get("research_to_writer")!;
    const loosened = parsePolicy(RESEARCH_HANDOFF_TEMPLATE.replace("deadline_ms: 30000", "deadline_ms: 90000")).contracts.get("research_to_writer")!;
    assert.notEqual(original.definitionDigest, loosened.definitionDigest);
  });
});
