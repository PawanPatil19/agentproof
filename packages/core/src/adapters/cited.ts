/**
 * Adapters from provider-native citations to the run envelope.
 *
 * Agents increasingly return citations grounded in supplied documents. These
 * adapters turn that output into claims + evidence so AgentProof can check it
 * independently, without asking the agent to emit a custom format.
 *
 * The provider's own `cited_text` (or, where a provider has none, the
 * annotated span of the answer) is used as the claim's *quote*, never as
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
  /**
   * Other names a provider may cite this source by, such as an uploaded
   * file's ID or filename. Only these, `id` and `locator` are matched, so a
   * citation resolves only to a source the host named.
   */
  aliases?: string[];
}

/** One citation, normalized across providers. */
export interface NormalizedCitation {
  /** Index into the supplied sources, when the provider reports one. */
  sourceIndex?: number;
  /**
   * Evidence ID, when the provider names a source rather than indexing one.
   * An ID the host never supplied stays unresolved, so evidence.reference reports it.
   */
  sourceId?: string;
  /** URL, for citations that point outside the supplied sources (e.g. web search). */
  url?: string;
  title?: string;
  /** The excerpt the citation stands on. Absent when the provider gives none worth checking. */
  citedText?: string;
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
      if (c.sourceId !== undefined) {
        evidenceId = c.sourceId;
      } else if (c.sourceIndex !== undefined) {
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

// ── OpenAI Responses API ─────────────────────────────────────────────────────
// Structural types for the parts of a Responses API response this adapter
// reads. Core takes no SDK dependency; any object of this shape works,
// including `Response` from the openai SDK.

interface OpenAIAnnotation {
  type: string;
  /** url_citation, container_file_citation: the span of `text` the citation covers. */
  start_index?: number;
  end_index?: number;
  /** file_citation: the position in `text` the citation is attached to. */
  index?: number;
  url?: string;
  title?: string;
  file_id?: string;
  filename?: string;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  annotations?: OpenAIAnnotation[] | null;
}

interface OpenAIOutputItem {
  type: string;
  content?: OpenAIContentPart[] | null;
}

export interface OpenAIResponseLike {
  output: OpenAIOutputItem[];
}

export interface OpenAIAdaptOptions extends AdaptOptions {
  /**
   * Use the annotated span of the answer as the claim's quote when it is a
   * plausible excerpt (default `true`). Set `false` if your model paraphrases:
   * claims then carry no quote and `evidence.require_quote` decides.
   */
  spanQuotes?: boolean;
}

/**
 * Adapt a Responses API response that used `file_search` and/or `web_search`.
 *
 * OpenAI annotations carry no cited text, only positions in the answer. So
 * the quote is the answer's own annotated span — for a file_citation, which
 * marks a single position, the sentence that ends there — and only when that
 * span reads like prose (several words, not a link or citation marker). A
 * quote from the answer is only a *claim* that the source says this; the
 * quote check still searches the host-supplied content for it. Anything else
 * leaves the quote undefined, for `evidence.require_quote` to decide.
 *
 * `sources` are what the host gave the model. A file_citation resolves to the
 * source whose `id` or `aliases` contain its `file_id`, else whose `aliases`
 * uniquely contain its `filename`; a url_citation to the source whose
 * `locator` or `aliases` contain the URL (ignoring utm_* parameters). Anything
 * else stays unresolved (files) or content-less (URLs): evidence content never
 * comes from the model's output.
 */
export function fromOpenAIResponse(
  response: OpenAIResponseLike,
  sources: SuppliedSource[] = [],
  options: OpenAIAdaptOptions = {},
): AdaptedRun {
  const spanQuotes = options.spanQuotes ?? true;
  const idOf = (i: number) => sources[i]!.id ?? `doc-${i}`;
  const findSource = (match: (s: SuppliedSource) => boolean): number[] =>
    sources.flatMap((s, i) => (match(s) ? [i] : []));

  const toCitation = (a: OpenAIAnnotation, span: string): NormalizedCitation => {
    const citedText = spanQuotes && isPlausibleExcerpt(span) ? span.trim() : undefined;
    switch (a.type) {
      case "file_citation":
      case "container_file_citation": {
        const byId = a.file_id === undefined ? [] : findSource((s) => s.id === a.file_id || (s.aliases ?? []).includes(a.file_id!));
        const byName = a.filename === undefined ? [] : findSource((s) => (s.aliases ?? []).includes(a.filename!));
        const index = byId[0] ?? (byName.length === 1 ? byName[0] : undefined);
        // An unmatched file gets an ID no supplied source has, so evidence.reference reports it.
        const sourceId = index !== undefined ? idOf(index) : `file:${a.file_id ?? a.filename ?? "unknown"}`;
        return { sourceId, title: a.filename, citedText };
      }
      case "url_citation": {
        if (a.url === undefined) return { citedText };
        const url = normalizeUrl(a.url);
        const [index] = findSource((s) => [s.locator, ...(s.aliases ?? [])].some((l) => l !== undefined && normalizeUrl(l) === url));
        return index !== undefined ? { sourceId: idOf(index), title: a.title, citedText } : { url: a.url, title: a.title, citedText };
      }
      default:
        // Unknown annotation type: keep the span, leave it unresolved so it is reported, not trusted.
        return { citedText };
    }
  };

  const segments: CitedSegment[] = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .flatMap((part) => segmentByAnnotations(part.text as string, part.annotations ?? [], toCitation));

  return fromCitedSegments(segments, sources, options);
}

/** Split text into uncited and cited segments by annotation spans. */
function segmentByAnnotations(
  text: string,
  annotations: OpenAIAnnotation[],
  toCitation: (a: OpenAIAnnotation, span: string) => NormalizedCitation,
): CitedSegment[] {
  const clamp = (n: number | undefined) => Math.min(Math.max(Number.isInteger(n) ? (n as number) : text.length, 0), text.length);
  const spans = annotations.map((a, order) => {
    if (a.start_index !== undefined && a.end_index !== undefined && a.end_index > a.start_index) {
      return { a, order, start: clamp(a.start_index), end: clamp(a.end_index), point: false };
    }
    // A point annotation covers the sentence that ends at it.
    const end = clamp(a.index ?? a.end_index);
    return { a, order, start: sentenceStart(text, end), end, point: true };
  });
  spans.sort((x, y) => x.start - y.start || x.end - y.end || x.order - y.order);

  const segments: CitedSegment[] = [];
  let cursor = 0;
  let last: CitedSegment | undefined;
  let lastSpan = { start: -1, end: -1 };
  for (const s of spans) {
    if (last && s.start === lastSpan.start && s.end === lastSpan.end) {
      last.citations.push(toCitation(s.a, text.slice(s.start, s.end)));
      continue;
    }
    const start = s.point ? Math.max(s.start, cursor) : s.start;
    if (start < cursor || start >= s.end) {
      // Overlaps a span already emitted: attach to it rather than split the text twice.
      const citation = toCitation(s.a, text.slice(start, s.end));
      if (last) last.citations.push(citation);
      else segments.push((last = { text: "", citations: [citation] }));
      continue;
    }
    if (start > cursor) segments.push({ text: text.slice(cursor, start), citations: [] });
    last = { text: text.slice(start, s.end), citations: [toCitation(s.a, text.slice(start, s.end))] };
    lastSpan = { start: s.start, end: s.end };
    segments.push(last);
    cursor = s.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), citations: [] });
  return segments;
}

/** Start of the sentence that ends at `end`: just after the previous terminator or newline. */
function sentenceStart(text: string, end: number): number {
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1]!)) e--;
  for (let k = e - 2; k >= 0; k--) {
    if (text[k] === "\n" || (/[.!?]/.test(text[k]!) && /\s/.test(text[k + 1]!))) {
      let start = k + 1;
      while (start < e && /\s/.test(text[start]!)) start++;
      return start;
    }
  }
  return 0;
}

/**
 * Whether an answer span reads like an excerpt worth searching for. Spans
 * that are links, bare URLs, bracketed markers or a single word (a domain,
 * say) are not: searching sources for them would fail on form, not substance.
 */
function isPlausibleExcerpt(span: string): boolean {
  const t = span.trim();
  if (/https?:\/\/|www\./i.test(t)) return false;
  if (/^[([【].*[)\]】]$/s.test(t)) return false;
  return t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 2;
}

/** Compare URLs without tracking parameters, fragments or a trailing slash. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    u.hash = "";
    return u.toString().replace(/\/(?=$|\?)/, "");
  } catch {
    return raw;
  }
}
