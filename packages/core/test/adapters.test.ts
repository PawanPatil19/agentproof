// Provider-native citations → envelope → independent checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fromAnthropicMessage, fromCitedSegments, fromOpenAIResponse, parsePolicy, verifyRun } from "@agentproof/core";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const message = JSON.parse(readFileSync(new URL("providers/anthropic-message.json", fixtures), "utf8"));
const response = JSON.parse(readFileSync(new URL("providers/openai-response.json", fixtures), "utf8"));
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

describe("fromOpenAIResponse", () => {
  // The host names its sources the way OpenAI cites them: the uploaded file's ID, and the page URL.
  const sources = [
    { ...documents[0]! },
    { ...documents[1]!, aliases: ["file-changelog32"] },
  ];
  const lenient = parsePolicy("api_version: agentproof/v1\npolicy: {id: p, version: 1}\n");
  const single = (annotation: Record<string, unknown>, text = "Offline sync is now generally available.") => ({
    output: [{ type: "message", content: [{ type: "output_text", text, annotations: [annotation] }] }],
  });

  it("turns each annotation into a claim with a span quote and resolvable evidence", () => {
    const adapted = fromOpenAIResponse(response, sources);
    assert.equal(adapted.output.claims.length, 2);
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["doc-changelog-3-2"]);
    assert.equal(adapted.output.claims[0]!.quote, "Offline sync is now generally available.");
    assert.deepEqual(adapted.output.claims[1]!.evidence_ids, ["doc-capabilities"], "utm_source is ignored when matching URLs");
    assert.equal(adapted.output.claims[1]!.quote, "Exports are available as PDF and Markdown");
    assert.equal(adapted.output.text, response.output[2].content[0].text);
    assert.ok(adapted.uncited_chars > 0, "connective text is counted, not claimed");
  });

  it("takes evidence content only from the supplied sources", () => {
    const adapted = fromOpenAIResponse(response, sources);
    assert.deepEqual(adapted.evidence.map((e) => e.content), sources.map((s) => s.content));
  });

  it("passes the independent checks when the sources really say it", () => {
    const receipt = verifyRun(envelope(fromOpenAIResponse(response, sources)), { policy, mode: "enforce" });
    assert.equal(receipt.decision, "allow", JSON.stringify(receipt.checks.filter((c) => c.status !== "pass")));
  });

  it("matches a file by a unique filename alias", () => {
    const byName = [sources[0]!, { ...documents[1]!, aliases: ["changelog-3.2.md"] }];
    const adapted = fromOpenAIResponse(response, byName);
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["doc-changelog-3-2"]);
  });

  it("blocks a citation to a file the host never supplied", () => {
    const forged = structuredClone(response);
    forged.output[2].content[0].annotations[0].file_id = "file-forged";
    forged.output[2].content[0].annotations[0].filename = "forged.md";
    const adapted = fromOpenAIResponse(forged, sources);
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["file:file-forged"]);
    const receipt = verifyRun(envelope(adapted), { policy, mode: "enforce" });
    assert.equal(receipt.decision, "block");
    assert.ok(receipt.reason_codes.includes("EVIDENCE_UNKNOWN_ID"));
  });

  it("blocks when the supplied text doesn't contain the annotated span", () => {
    const changed = structuredClone(sources);
    changed[1]!.content = "Version 3.2 shipped on 12 August 2026. Offline sync remains in beta.";
    const receipt = verifyRun(envelope(fromOpenAIResponse(response, changed)), { policy, mode: "enforce" });
    assert.ok(receipt.reason_codes.includes("QUOTE_NOT_FOUND"));
  });

  it("sends url-only citations to review: the host never captured that content", () => {
    const adapted = fromOpenAIResponse(single({ type: "url_citation", start_index: 0, end_index: 40, url: "https://news.example/a?utm_source=openai", title: "News" }));
    assert.equal(adapted.evidence.length, 1);
    assert.equal(adapted.evidence[0]!.locator, "https://news.example/a?utm_source=openai");
    assert.equal(adapted.evidence[0]!.content, undefined);
    const receipt = verifyRun(envelope(adapted), { policy: lenient, mode: "enforce" });
    assert.equal(receipt.decision, "review");
    assert.ok(receipt.reason_codes.includes("QUOTE_CONTENT_UNAVAILABLE"));
  });

  it("leaves the quote undefined when the span is a link, not an excerpt", () => {
    const text = "Offline sync is GA ([lumen.example](https://lumen.example/changelog/3.2)).";
    const adapted = fromOpenAIResponse(single({ type: "url_citation", start_index: 19, end_index: 73, url: "https://lumen.example/changelog/3.2" }, text), sources);
    assert.equal(adapted.output.claims[0]!.quote, undefined);
    assert.deepEqual(adapted.output.claims[0]!.evidence_ids, ["doc-changelog-3-2"], "matched by locator");
    const strict = verifyRun(envelope(adapted), { policy, mode: "enforce" });
    assert.ok(strict.reason_codes.includes("QUOTE_MISSING"), "require_quote decides");
  });

  it("can skip span quotes for paraphrasing models", () => {
    const adapted = fromOpenAIResponse(response, sources, { spanQuotes: false });
    assert.ok(adapted.output.claims.every((c) => c.quote === undefined));
  });

  it("groups annotations on the same span into one segment", () => {
    const text = "Offline sync is now generally available.";
    const both = { output: [{ type: "message", content: [{ type: "output_text", text, annotations: [
      { type: "file_citation", index: 40, file_id: "file-changelog32" },
      { type: "file_citation", index: 40, file_id: "file-other" },
    ] }] }] };
    const adapted = fromOpenAIResponse(both, sources);
    assert.equal(adapted.output.claims.length, 2);
    assert.equal(adapted.output.text, text);
    assert.deepEqual(adapted.output.claims.map((c) => c.evidence_ids[0]), ["doc-changelog-3-2", "file:file-other"]);
  });
});
