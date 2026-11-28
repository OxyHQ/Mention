import { HASHTAG_BODY_SOURCE, HASHTAG_CONTINUE_CLASS } from '@mention/shared-types/hashtags';

/** The hashtag being typed: where its `#` is, and what follows it so far. */
export interface ActiveHashtag {
  start: number;
  query: string;
}

// The `#` must open a word: one inside a word or a URL path is not a hashtag.
const ENDING_IN_HASHTAG = new RegExp(
  `(^|[^${HASHTAG_CONTINUE_CLASS}#/])#(${HASHTAG_BODY_SOURCE})$`,
  'u',
);
const CONTINUES = new RegExp(`^[${HASHTAG_CONTINUE_CLASS}]`, 'u');

/** The hashtag the cursor sits at the end of, if any. */
export function activeHashtag(text: string, cursor: number): ActiveHashtag | null {
  if (CONTINUES.test(text.slice(cursor, cursor + 2))) return null;
  const match = ENDING_IN_HASHTAG.exec(text.slice(0, cursor));
  if (!match) return null;
  return { start: match.index + match[1].length, query: match[2] };
}
