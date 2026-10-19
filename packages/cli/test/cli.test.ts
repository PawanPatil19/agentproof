// The CLI as a user runs it: real processes, real exit codes, real files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const policy = join(fixtures, "agentproof.yaml");
const run = (name: string) => join(fixtures, "runs", `${name}.json`);

function cli(args: string[], cwd = mkdtempSync(join(tmpdir(), "agentproof-"))) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--conditions=source", entry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, cwd };
}

describe("agentproof CLI", () => {
  it("inspect: diagnoses without failing and writes private receipt + report", () => {
    const r = cli(["inspect", run("missing-evidence-id")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would block|ALLOW/);
    const receiptPath = join(r.cwd, "agentproof-reports", "fx-missing-evidence-id.json");
    assert.ok(existsSync(join(r.cwd, "agentproof-reports", "fx-missing-evidence-id.html")));
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).policy.id, "baseline");
  });

  it("check: exit 0 allow, 2 block, 2 review", () => {
    assert.equal(cli(["check", run("valid"), "--policy", policy]).code, 0);
    const blocked = cli(["check", run("fabricated-quote"), "--policy", policy]);
    assert.equal(blocked.code, 2);
    assert.match(blocked.out, /BLOCK/);
    assert.match(blocked.out, /QUOTE_NOT_FOUND|does not appear/);
    assert.equal(cli(["check", run("content-not-captured"), "--policy", policy]).code, 2);
  });

  it("check --mode observe never fails the build but reports the would-be decision", () => {
    const r = cli(["check", run("fabricated-quote"), "--policy", policy, "--mode", "observe"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /would block in enforce mode/);
  });

  it("exit 3 on configuration errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproof-"));
    writeFileSync(join(dir, "bad.yaml"), "api_version: agentproof/v1\npolicy: {id: p, version: 1}\nchecks: {evidence: {require_sources: true}}\n");
    const r = cli(["policy", "validate", "bad.yaml"], dir);
    assert.equal(r.code, 3);
    assert.match(r.err, /require_sources/);
    assert.equal(cli(["check", run("valid")]).code, 3, "check without --policy is a usage error");
    assert.equal(cli(["check", "nope.json", "--policy", policy]).code, 3);
    assert.equal(cli(["inspect", run("valid"), "--bogus"]).code, 3);
  });

  it("init writes a policy that validates, and refuses to overwrite", () => {
    const r = cli(["init"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(cli(["policy", "validate", "agentproof.yaml"], r.cwd).code, 0);
    assert.equal(cli(["init"], r.cwd).code, 3);
  });

  it("report refuses a malformed or hostile receipt", () => {
    const first = cli(["check", run("valid"), "--policy", policy, "--out", "out"]);
    const path = join(first.cwd, "out", "fx-valid.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.claims[0].status = `pass"><form action="https://evil.example">`;
    writeFileSync(path, JSON.stringify(receipt));
    const r = cli(["report", "out/fx-valid.json"], first.cwd);
    assert.equal(r.code, 3);
    assert.match(r.err, /not a valid AgentProof receipt/);
  });

  it("keys + check --sign-key + verify-receipt round trip; tampering is caught", () => {
    const k = cli(["keys", "generate", "--out", "keys"]);
    assert.equal(k.code, 0, k.err);
    assert.equal(statSync(join(k.cwd, "keys", "agentproof-signing.key")).mode & 0o777, 0o600);
    const checked = cli(["check", run("valid"), "--policy", policy, "--sign-key", "keys/agentproof-signing.key", "--out", "out"], k.cwd);
    assert.equal(checked.code, 0, checked.err);
    const ok = cli(["verify-receipt", "out/fx-valid.json", "--public-key", "keys/agentproof-signing.pub"], k.cwd);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /verified/);

    const path = join(k.cwd, "out", "fx-valid.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.decision = "block";
    writeFileSync(path, JSON.stringify(receipt));
    const bad = cli(["verify-receipt", "out/fx-valid.json", "--public-key", "keys/agentproof-signing.pub"], k.cwd);
    assert.equal(bad.code, 2);
    assert.match(bad.out, /edited after it was sealed/);
  });

  it("report re-renders a receipt with claim text from the run file", () => {
    const first = cli(["check", run("valid"), "--policy", policy, "--out", "out"]);
    const r = cli(["report", "out/fx-valid.json", "--run", run("valid"), "--out", "r.html"], first.cwd);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(first.cwd, "r.html"), "utf8"), /Offline sync is generally available/);
  });
});
