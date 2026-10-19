// Salted claim commitments and RFC 8785 canonical JSON.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalJson,
  claimSalt,
  commitmentKeyBytes,
  discloseClaim,
  generateCommitmentKey,
  parsePolicy,
  parseReceipt,
  safeText,
  verifyClaimDisclosure,
  verifyRun,
} from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const policy = parsePolicy(readFileSync(new URL("agentproof.yaml", fixtures), "utf8"));
const run = () => JSON.parse(readFileSync(new URL("runs/valid.json", fixtures), "utf8"));

describe("salted claim commitments", () => {
  const key = generateCommitmentKey();

  it("a receipt never carries an unsalted hash of claim text", () => {
    const envelope = run();
    const receipt = verifyRun(envelope, { policy, commitmentKey: key });
    assert.ok(receipt.claims.length > 0);
    const json = JSON.stringify(receipt);
    for (const claim of envelope.output.claims) {
      const plain = createHash("sha256").update(claim.text, "utf8").digest("hex");
      assert.ok(!json.includes(plain), "the plain sha256 of a claim would let anyone confirm a guess");
    }
    for (const c of receipt.claims) assert.match(c.text_commitment, /^hmac-sha256:[0-9a-f]{64}$/);
    assert.ok(parseReceipt(receipt).ok);
  });

  it("the same claim under different keys commits differently; the same key is deterministic", () => {
    const a = verifyRun(run(), { policy, commitmentKey: key }).claims[0]!.text_commitment;
    const b = verifyRun(run(), { policy, commitmentKey: key }).claims[0]!.text_commitment;
    const c = verifyRun(run(), { policy, commitmentKey: generateCommitmentKey() }).claims[0]!.text_commitment;
    const d = verifyRun(run(), { policy }).claims[0]!.text_commitment;
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d, "without a key, salts are random");
  });

  it("an issuer can open one claim to an auditor, and only with the right text", () => {
    const envelope = run();
    const receipt = verifyRun(envelope, { policy, commitmentKey: key });
    const [first, second] = envelope.output.claims;
    const disclosure = discloseClaim(key, receipt, first.id, first.text);
    assert.deepEqual(Object.keys(disclosure).sort(), ["claim_id", "salt", "text"]);
    assert.ok(verifyClaimDisclosure(receipt, disclosure));
    assert.equal(verifyClaimDisclosure(receipt, { ...disclosure, text: `${first.text} ` }), false);
    if (second) assert.equal(verifyClaimDisclosure(receipt, { ...disclosure, claim_id: second.id }), false, "one salt opens one claim");
    assert.equal(verifyClaimDisclosure(receipt, { ...disclosure, salt: "zz" }), false);
    assert.equal(verifyClaimDisclosure(receipt, { ...disclosure, claim_id: "nope" }), false);
    assert.throws(() => discloseClaim(key, receipt, first.id, "something else"), /does not match/);
    assert.throws(() => discloseClaim(generateCommitmentKey(), receipt, first.id, first.text), /does not match/);
  });

  it("salts follow the published derivation", () => {
    const k = Buffer.alloc(32, 7);
    const expected = createHmac("sha256", k).update(Buffer.from("agentproof.claim-salt/v1\0run-1\0c1", "utf8")).digest("hex");
    assert.equal(claimSalt(k, "run-1", "c1").toString("hex"), expected);
  });

  it("commitment keys: hex or base64 text, at least 16 bytes", () => {
    assert.equal(commitmentKeyBytes("00".repeat(32)).length, 32);
    assert.equal(commitmentKeyBytes(Buffer.alloc(32, 1).toString("base64")).length, 32);
    assert.throws(() => commitmentKeyBytes("abcd"), /at least 16 bytes/);
    assert.throws(() => commitmentKeyBytes(new Uint8Array(8)), /at least 16 bytes/);
  });
});

describe("RFC 8785 canonical JSON", () => {
  it("matches the RFC's worked example (§3.2.2)", () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}',
    );
    assert.equal(
      canonicalJson(input),
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units, not code points (§3.2.3)", () => {
    const input = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    // Compare text: JSON.parse would move the integer-like key "1" first again,
    // which is exactly the trap a naive JSON.stringify of a sorted copy falls into.
    assert.equal(
      canonicalJson(input),
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
    assert.equal(canonicalJson({ b: 1, 10: 2, a: { 2: 1, x: 0 }, "": 3 }), '{"":3,"10":2,"a":{"2":1,"x":0},"b":1}');
    assert.equal(canonicalJson({ z: 1, 2: 0 }), '{"2":0,"z":1}');
    assert.equal(canonicalJson({ "-1": 0, "1": 0, A: 0 }), '{"-1":0,"1":0,"A":0}');
  });

  it("serializes numbers per ECMAScript (Appendix B samples)", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [-0, "0"], [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
      [9007199254740992, "9007199254740992"], [1e21, "1e+21"], [1e-7, "1e-7"], [0.000001, "0.000001"],
      [1e23, "1e+23"], [295147905179352830000, "295147905179352830000"], [333333333.3333333, "333333333.3333333"],
    ];
    for (const [n, text] of cases) assert.equal(canonicalJson(n), text);
  });

  it("persisted strings are valid Unicode even when a cap splits an emoji", () => {
    const capped = safeText("ab😀", 3);
    assert.equal(capped, "ab�");
    assert.equal(safeText("x\ud800y"), "x�y");
    assert.equal(safeText("ok 😀"), "ok 😀");
  });
});
