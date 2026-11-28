/**
 * The guard between a translation model and anything Mention stores or serves.
 *
 * Translation is routed across many models, and a prompt instruction is a
 * request, not a guarantee: a model may echo the `<text>` wrapper the prompt
 * puts around the source, and may translate, respell or drop the entities a
 * reader can follow (mentions, handles, hashtags, cashtags, URLs). Both are
 * enforced here, in code:
 *
 *  1. {@link protectEntities} replaces every entity the post renderer
 *     linkifies with an opaque sentinel (`⟦0⟧`, `⟦1⟧`, …) before the text is
 *     sent. The entity list is not maintained here: it is `scanTextEntities`,
 *     the same scanner the frontend linkifier, the outbound-federation
 *     linkifier and the classifiers use, run with every kind it knows.
 *  2. {@link finalizeTranslation} strips one echoed wrapper, then requires
 *     every sentinel back exactly once and unaltered, and restores the
 *     originals. Anything else is a {@link TranslationOutputError} — the
 *     caller stores nothing.
 */

import {
  scanTextEntities,
  trimUrlTrailingPunctuation,
  type TextEntity,
} from '@mention/shared-types/textEntities';

const SENTINEL_OPEN = '⟦';
const SENTINEL_CLOSE = '⟧';
/** One well-formed sentinel. No leading zeros, so `⟦00⟧` is not `⟦0⟧`. */
const SENTINEL_PATTERN = /⟦(0|[1-9]\d*)⟧/g;

const WRAPPER_OPEN = '<text>';
const WRAPPER_CLOSE = '</text>';
/** One surrounding Markdown code fence, with an optional info string. */
const CODE_FENCE_PATTERN = /^```[^\n]*\n([\s\S]*?)\n?```$/;

/** What the model must do with the sentinels, for the system prompt. */
export const SENTINEL_PROMPT_RULE =
  `Tokens of the form ${SENTINEL_OPEN}0${SENTINEL_CLOSE}, ${SENTINEL_OPEN}1${SENTINEL_CLOSE}, … ` +
  'stand for names, links and tags that must not change. Copy every such token exactly as ' +
  'written, once each, where it belongs in the translated sentence. Never translate, alter, ' +
  'merge or drop them.';

/**
 * The model's answer could not be accepted as a translation of its source. Not
 * the caller's fault and not an outage: a bad completion, reported as 502 so a
 * client can retry, and never cached.
 */
export class TranslationOutputError extends Error {
  readonly status = 502;
  readonly code = 'TRANSLATION_OUTPUT_INVALID';

  constructor(readonly reason: 'empty' | 'wrapper' | 'tokens') {
    super(`Translation output rejected (${reason})`);
    this.name = 'TranslationOutputError';
  }
}

/** A source with its entities swapped out, and what each sentinel stands for. */
export interface ProtectedText {
  /** The text to send to the model. */
  text: string;
  /** `tokens[n]` is the original text sentinel `⟦n⟧` replaced. */
  tokens: string[];
}

/** The span of the entity that must survive verbatim. */
function protectedSpan(entity: TextEntity): { start: number; end: number } {
  if (entity.kind !== 'url') return entity;
  // A sentence's closing punctuation is prose, not link: leave it to the model.
  const { url } = trimUrlTrailingPunctuation(entity.raw);
  return {
    start: entity.start,
    end: entity.start + (url.length > 0 ? url.length : entity.raw.length),
  };
}

/**
 * Replace every linkifiable entity in `source` with a sentinel.
 *
 * A source that already contains sentinel-shaped text has that text protected
 * too, so a literal `⟦0⟧` someone typed can never be confused with ours.
 */
export function protectEntities(source: string): ProtectedText {
  const spans: { start: number; end: number }[] = scanTextEntities(source).map(protectedSpan);

  // Sentinel look-alikes in the plain runs between entities.
  let cursor = 0;
  const literal: { start: number; end: number }[] = [];
  for (const span of [...spans, { start: source.length, end: source.length }]) {
    const run = source.slice(cursor, span.start);
    for (const match of run.matchAll(/⟦[^⟦⟧]*⟧/g)) {
      const start = cursor + (match.index ?? 0);
      literal.push({ start, end: start + match[0].length });
    }
    cursor = span.end;
  }
  spans.push(...literal);
  spans.sort((a, b) => a.start - b.start);

  const tokens: string[] = [];
  let text = '';
  cursor = 0;
  for (const span of spans) {
    text += `${source.slice(cursor, span.start)}${SENTINEL_OPEN}${tokens.length}${SENTINEL_CLOSE}`;
    tokens.push(source.slice(span.start, span.end));
    cursor = span.end;
  }
  return { text: text + source.slice(cursor), tokens };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Remove ONE echoed prompt wrapper: a surrounding code fence, then a leading
 * `<text>` and a trailing `</text>` — each only when the source itself does not
 * begin or end that way, so a post that really is a code block, or really
 * starts with `<text>`, keeps it.
 */
function stripWrapper(output: string, source: string): string {
  const trimmedSource = source.trim();
  let text = output.trim();
  const fenced = trimmedSource.startsWith('```') ? null : CODE_FENCE_PATTERN.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();

  if (text.startsWith(WRAPPER_OPEN) && !trimmedSource.startsWith(WRAPPER_OPEN)) {
    text = text.slice(WRAPPER_OPEN.length).trim();
  }
  if (text.endsWith(WRAPPER_CLOSE) && !trimmedSource.endsWith(WRAPPER_CLOSE)) {
    text = text.slice(0, -WRAPPER_CLOSE.length).trim();
  }
  return text;
}

/**
 * Turn a model's answer for `source` into the text Mention may store.
 *
 * `source` is the PROTECTED text that was sent; `tokens` restores it. Throws
 * {@link TranslationOutputError} when the answer is empty once unwrapped, still
 * carries a wrapper the source did not, or does not return every sentinel
 * exactly once and unaltered.
 */
export function finalizeTranslation(output: string, source: ProtectedText): string {
  const text = stripWrapper(output, source.text);
  if (text.length === 0) throw new TranslationOutputError('empty');

  for (const marker of [WRAPPER_OPEN, WRAPPER_CLOSE]) {
    if (count(text, marker) > count(source.text, marker)) {
      throw new TranslationOutputError('wrapper');
    }
  }

  // Every sentinel exactly once, and no bracket left over from a mangled one.
  const seen = new Set<number>();
  for (const match of text.matchAll(SENTINEL_PATTERN)) {
    const index = Number(match[1]);
    if (index >= source.tokens.length || seen.has(index)) {
      throw new TranslationOutputError('tokens');
    }
    seen.add(index);
  }
  if (
    seen.size !== source.tokens.length ||
    count(text, SENTINEL_OPEN) !== count(source.text, SENTINEL_OPEN) ||
    count(text, SENTINEL_CLOSE) !== count(source.text, SENTINEL_CLOSE)
  ) {
    throw new TranslationOutputError('tokens');
  }

  return text.replace(SENTINEL_PATTERN, (_, index: string) => source.tokens[Number(index)] ?? '');
}
