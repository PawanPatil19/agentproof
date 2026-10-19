// Provider-native citations → envelope → independent checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fromAnthropicMessage, fromCitedSegments, parsePolicy, verifyRun } from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const message = JSON.parse(readFileSync(new URL("providers/anthropic-message.json", fixtures), "utf8"));
const policy = parsePolicy(readFileSync(new URL("agentproof.yaml", fixtures), "utf8"));

const documents = [
  {
    id: "doc-capabilities",
    source_id: "product-docs",
    title: "Capabilities",
    locator: "https://docs.lumen.example/capabilities",
    published_at: "2026-08-14",
    content: "Lumen Notes 3.2 supports offline sync on iOS and Android. Exports are available as PDF and Markdown. Team workspaces allow up to 50 members on the Pro plan.",
  },
  {
    id: "doc-changelog-3-2",
    source_id: "changelog",
    title: "Changelog 3.2",
    locator: "https://lumen.example/changelog/3.2",
    published_at: "2026-08-12",
    content: "Version 3.2 shipped on 12 August 2026. Offline sync is now generally available. Pricing for the Pro plan is $12 per member per month.",
  },
];

const envelope = (adapted: ReturnType<typeof fromAnthropicMessage>) => ({
  api_version: "agentproof/v1",
  run_id: "provider-run",
  boundary: "final_answer",
  output: adapted.output,
  evidence: adapted.evidence,
  submitted_at: "2026-10-19T10:00:00.000Z",
});

describe("fromAnthropicMessage", () => {
  it("turns each citation into a claim with a quote and resolvable evidence", () => {
    const adapted = fromAnthropicMessage(message, documents);
    assert.equal(adapted.output.claims.length, 2);
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["doc-changelog-3-2"]);
    assert.equal(adapted.output.claims[0]!.quote, "Offline sync is now generally available.");
    assert.match(adapted.output.text, /^Here is what changed in 3.2\. Offline sync/);
    assert.ok(adapted.uncited_chars > 0, "connective text is counted, not claimed");
  });

  it("passes the independent checks when the sources really say it", () => {
    const receipt = verifyRun(envelope(fromAnthropicMessage(message, documents)), { policy, mode: "enforce" });
    assert.equal(receipt.decision, "allow", JSON.stringify(receipt.checks.filter((c) => c.status !== "pass")));
  });

  it("blocks a citation to a document the host never supplied", () => {
    const forged = structuredClone(message);
    forged.content[1].citations[0].document_index = 7;
    const receipt = verifyRun(envelope(fromAnthropicMessage(forged, documents)), { policy, mode: "enforce" });
    assert.ok(receipt.reason_codes.includes("EVIDENCE_UNKNOWN_ID"));
  });

  it("blocks when the supplied text doesn't contain the cited quote", () => {
    const changed = structuredClone(documents);
    changed[1]!.content = "Version 3.2 shipped on 12 August 2026. Offline sync remains in beta.";
    const receipt = verifyRun(envelope(fromAnthropicMessage(message, changed)), { policy, mode: "enforce" });
    assert.ok(receipt.reason_codes.includes("QUOTE_NOT_FOUND"));
  });

  it("sends web citations to review: the host never captured that content", () => {
    const web = { content: [{ type: "text", text: "Sync is GA", citations: [{ type: "web_search_result_location", url: "https://news.example/a", title: "News", cited_text: "Sync is GA now.", encrypted_index: "x" }] }] };
    const adapted = fromAnthropicMessage(web);
    assert.equal(adapted.evidence[0]!.locator, "https://news.example/a");
    const receipt = verifyRun(envelope(adapted), { policy: parsePolicy("api_version: agentproof/v1\npolicy: {id: p, version: 1}\n"), mode: "enforce" });
    assert.equal(receipt.decision, "review");
    assert.ok(receipt.reason_codes.includes("QUOTE_CONTENT_UNAVAILABLE"));
  });

  it("maps search results after documents", () => {
    const msg = { content: [{ type: "text", text: "X", citations: [{ type: "search_result_location", source: "https://kb.example/1", title: "KB", cited_text: "abc def ghi jkl", search_result_index: 0, start_block_index: 0, end_block_index: 0 }] }] };
    const adapted = fromAnthropicMessage(msg, documents, { searchResults: [{ content: "abc def ghi jkl mno" }] });
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["search-0"]);
  });
});

describe("fromCitedSegments", () => {
  it("can turn uncited text into evidence-less claims", () => {
    const adapted = fromCitedSegments([{ text: "Unsupported assertion.", citations: [] }], [], { uncited: "claims" });
    const receipt = verifyRun(envelope(adapted as never), { policy: parsePolicy("api_version: agentproof/v1\npolicy: {id: p, version: 1}\n"), mode: "enforce" });
    assert.ok(receipt.reason_codes.includes("EVIDENCE_MISSING"));
  });
});
