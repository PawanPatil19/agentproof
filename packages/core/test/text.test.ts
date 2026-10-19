import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLocator, normalizeForMatch, redact, sanitizeLocator } from "@agentproof/core";

describe("text helpers", () => {
  it("normalizes presentation differences but not wording", () => {
    assert.equal(normalizeForMatch("It’s  “ready” — now"), normalizeForMatch("it's \"ready\" - now"));
    assert.notEqual(normalizeForMatch("launched in June"), normalizeForMatch("launched in July"));
  });

  it("redacts well-known secret formats", () => {
    const text = "key sk-live_ABCDEFGHIJKLMNOPQRSTUVWX token ghp_abcdefghijklmnopqrstuvwxyz0123 aws AKIAABCDEFGHIJKLMNOP";
    const out = redact(text);
    assert.doesNotMatch(out, /sk-live|ghp_|AKIA/);
    assert.match(out, /\[REDACTED:api-key\]/);
  });

  it("classifies locators", () => {
    assert.equal(classifyLocator("https://example.com/a"), "url");
    assert.equal(classifyLocator("docs/policy.md"), "path");
    assert.equal(classifyLocator("kb://policy/12"), "path");
    assert.equal(classifyLocator("javascript:alert(1)"), "unsafe");
    assert.equal(classifyLocator(" JavaScript:alert(1)"), "unsafe");
    assert.equal(classifyLocator("data:text/html,<b>x</b>"), "unsafe");
    assert.equal(classifyLocator("https://"), "malformed");
  });

  it("strips credentials, query strings and fragments from URLs", () => {
    assert.equal(sanitizeLocator("https://user:pw@example.com/doc?token=abc#p2"), "https://example.com/doc");
  });
});
