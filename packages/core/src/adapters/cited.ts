/**
 * Adapters from provider-native citations to the run envelope.
 *
 * Agents increasingly return citations grounded in supplied documents. These
 * adapters turn that output into claims + evidence so AgentProof can check it
 * independently, without asking the agent to emit a custom format.
 *
 * The provider's own `cited_text` is used as the claim's *quote*, never as
 * evidence content: evidence content must come from what the host actually
 * supplied, otherwise a citation would be grounding itself.
 */
import type { Claim, EvidenceRecord } from "../types.ts";

/** A source the host supplied to the model, in the order it was supplied. */
export interface SuppliedSource {
  /** Stable ID; defaults to `doc-<index>`. */
  id?: string;
  source_id?: string;
  locator?: string;
  title?: string;
  /** The text the model saw. Required for quote grounding. */
  content?: string;
  published_at?: string;
  revision?: string;
}

/** One citation, normalized across providers. */
export interface NormalizedCitation {
  /** Index into the supplied sources, when the provider reports one. */
  sourceIndex?: number;
  /** URL, for citations that point outside the supplied sources (e.g. web search). */
  url?: string;
  title?: string;
  citedText: string;
}

/** A span of answer text and the citations attached to it. */
export interface CitedSegment {
  text: string;
  citations: NormalizedCitation[];
}

export interface AdaptedRun {
  output: { text: string; claims: Claim[] };
  evidence: EvidenceRecord[];
  /** Characters of answer text that carried no citation (not turned into claims). */
  uncited_chars: number;
}

export interface AdaptOptions {
  /**
   * What to do with text that carries no citation. `ignore` (default) keeps it
   * out of the claims — providers split connective phrases into their own
   * blocks. `claims` turns every non-blank uncited segment into an evidence-less
   * claim, so `evidence.reference` flags it.
   */
  uncited?: "ignore" | "claims";
}

const urlId = (url: string) => `web-${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100)}`;

/**
 * Provider-neutral core: one claim per citation (so every citation is checked
 * on its own), evidence from the supplied sources plus any cited URLs.
 */
export function fromCitedSegments(segments: CitedSegment[], sources: SuppliedSource[] = [], options: AdaptOptions = {}): AdaptedRun {
  const evidence = new Map<string, EvidenceRecord>();
  sources.forEach((s, i) => {
    const id = s.id ?? `doc-${i}`;
    evidence.set(id, {
      id,
      source_id: s.source_id,
      locator: s.locator,
      content: s.content,
      published_at: s.published_at,
      revision: s.revision,
    });
  });

  const claims: Claim[] = [];
  let uncited = 0;
  segments.forEach((segment, si) => {
    const text = segment.text.trim();
    if (segment.citations.length === 0) {
      uncited += text.length;
      if (options.uncited === "claims" && text !== "") claims.push({ id: `s${si}`, text, evidence_ids: [] });
      return;
    }
    segment.citations.forEach((c, ci) => {
      let evidenceId: string | undefined;
      if (c.sourceIndex !== undefined) {
        evidenceId = sources[c.sourceIndex]?.id ?? `doc-${c.sourceIndex}`;
        // A citation to an index the host never supplied stays unresolved on purpose:
        // evidence.reference will report it.
      } else if (c.url) {
        evidenceId = urlId(c.url);
        // Web content wasn't supplied by the host, so it is recorded without content:
        // quote grounding is inconclusive until the host captures the page itself.
        if (!evidence.has(evidenceId)) evidence.set(evidenceId, { id: evidenceId, locator: c.url });
      }
      claims.push({
        id: `s${si}-c${ci}`,
        text,
        quote: c.citedText,
        evidence_ids: evidenceId ? [evidenceId] : [],
      });
    });
  });

  return {
    output: { text: segments.map((s) => s.text).join(""), claims },
    evidence: [...evidence.values()],
    uncited_chars: uncited,
  };
}

// ── Anthropic Messages API ───────────────────────────────────────────────────
// Structural types for the parts of a Messages API response this adapter
// reads. Core takes no SDK dependency; any object of this shape works,
// including `Anthropic.Message` from @anthropic-ai/sdk.

interface AnthropicCitation {
  type: string;
  cited_text: string;
  document_index?: number;
  document_title?: string | null;
  search_result_index?: number;
  source?: string;
  url?: string;
  title?: string | null;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  citations?: AnthropicCitation[] | null;
}

export interface AnthropicMessageLike {
  content: AnthropicContentBlock[];
}

/**
 * Adapt a Messages API response whose documents were sent with
 * `citations: { enabled: true }`.
 *
 * `documents` are the document blocks in the order sent (matching
 * `document_index`). `searchResults` are search-result blocks in the order
 * sent (matching `search_result_index`). Supply each one's text as `content`
 * so quotes can be grounded; for PDFs, supply the extracted text.
 */
export function fromAnthropicMessage(
  message: AnthropicMessageLike,
  documents: SuppliedSource[] = [],
  options: AdaptOptions & { searchResults?: SuppliedSource[] } = {},
): AdaptedRun {
  const searchResults = options.searchResults ?? [];
  // Search results become sources after the documents, so indices stay unique.
  const sources: SuppliedSource[] = [
    ...documents,
    ...searchResults.map((s, i) => ({ ...s, id: s.id ?? `search-${i}` })),
  ];

  const segments: CitedSegment[] = message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => ({
      text: block.text as string,
      citations: (block.citations ?? []).map((c): NormalizedCitation => {
        switch (c.type) {
          case "char_location":
          case "page_location":
          case "content_block_location":
            return { sourceIndex: c.document_index, title: c.document_title ?? undefined, citedText: c.cited_text };
          case "search_result_location":
            return {
              sourceIndex: c.search_result_index === undefined ? undefined : documents.length + c.search_result_index,
              url: c.source,
              title: c.title ?? undefined,
              citedText: c.cited_text,
            };
          case "web_search_result_location":
            return { url: c.url, title: c.title ?? undefined, citedText: c.cited_text };
          default:
            // Unknown citation type: keep the quote, leave it unresolved so it is reported, not trusted.
            return { citedText: c.cited_text };
        }
      }),
    }));

  return fromCitedSegments(segments, sources, options);
}
