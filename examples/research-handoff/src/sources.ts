/**
 * A tiny fictional document store standing in for real retrieval.
 * "Lumen Notes" is invented; nothing here describes a real product.
 */
import { sha256, type EvidenceRecord } from "@agentproof/core";

interface Doc {
  id: string;
  source_id: string;
  locator: string;
  published_at: string;
  content: string;
  values?: EvidenceRecord["values"];
}

const DOCS: Doc[] = [
  {
    id: "doc-capabilities",
    source_id: "product-docs",
    locator: "https://docs.lumen.example/capabilities?ref=search",
    published_at: "2026-08-14",
    content:
      "Lumen Notes 3.2 supports offline sync on iOS and Android. " +
      "Exports are available as PDF and Markdown. " +
      "Team workspaces allow up to 50 members on the Pro plan.",
  },
  {
    id: "doc-changelog-3-2",
    source_id: "changelog",
    locator: "https://lumen.example/changelog/3.2",
    published_at: "2026-08-12",
    content:
      "Version 3.2 shipped on 12 August 2026. Offline sync is now generally available. " +
      "Pricing for the Pro plan is $12 per member per month.",
    values: { pro_price: { value: 12, unit: "USD/member/month" } },
  },
];

export function search(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/);
  return DOCS.filter((d) => words.some((w) => d.content.toLowerCase().includes(w))).map((d) => d.id);
}

/** Read a document as a captured evidence record (content + capture-time hash). */
export function read(id: string, capturedAt: string): EvidenceRecord {
  const doc = DOCS.find((d) => d.id === id);
  if (!doc) throw new Error(`no document ${id}`);
  return { ...doc, content_sha256: sha256(doc.content), captured_at: capturedAt };
}
