import { parseArticleMarkdown } from '@/utils/markdownRanges';

/**
 * The grammar the live editor formats.
 *
 * Ranges are (start, length) offsets into the RAW text, so every assertion here
 * doubles as a check that the parser never rewrites the author's string — the
 * property that lets an article written years ago in a plain textarea open in
 * this editor unchanged.
 */

type Span = { type: string; text: string };

/** Ranges resolved back to the substrings they cover — the readable form. */
function spans(value: string): Span[] {
  return parseArticleMarkdown(value).map((range) => ({
    type: range.type,
    text: value.slice(range.start, range.start + range.length),
  }));
}

function typed(value: string, type: string): string[] {
  return spans(value).filter((span) => span.type === type).map((span) => span.text);
}

describe('parseArticleMarkdown — block grammar', () => {
  it('formats a heading and dims its hashes', () => {
    expect(typed('# Title', 'h1')).toEqual(['# Title']);
    expect(typed('# Title', 'syntax')).toEqual(['# ']);
  });

  it('accepts every heading depth the syntax allows', () => {
    expect(typed('### Deeper', 'h1')).toEqual(['### Deeper']);
  });

  it('does not treat a bare hash as a heading', () => {
    expect(typed('#hashtag not a heading', 'h1')).toEqual([]);
  });

  it('formats a blockquote and dims its marker', () => {
    expect(typed('> quoted line', 'blockquote')).toEqual(['> quoted line']);
    expect(typed('> quoted line', 'syntax')).toEqual(['>']);
  });

  it('formats a fenced code block across lines', () => {
    const value = 'before\n```\ncode line\n```\nafter';
    expect(typed(value, 'pre')).toEqual(['```\ncode line\n```']);
  });

  it('keeps formatting a fence the author has not closed yet', () => {
    // Otherwise the block flickers back to plain on every keystroke until the
    // closing fence is typed.
    const value = 'intro\n```\nstill typing';
    expect(typed(value, 'pre')).toEqual(['```\nstill typing']);
  });

  it('leaves markdown INSIDE a fence verbatim', () => {
    const value = '```\n**not bold** and # not a heading\n```';
    expect(typed(value, 'bold')).toEqual([]);
    expect(typed(value, 'h1')).toEqual([]);
  });
});

describe('parseArticleMarkdown — inline grammar', () => {
  it('formats bold with either delimiter', () => {
    expect(typed('a **bold** b', 'bold')).toEqual(['**bold**']);
    expect(typed('a __bold__ b', 'bold')).toEqual(['__bold__']);
  });

  it('formats italic with either delimiter', () => {
    expect(typed('a *soft* b', 'italic')).toEqual(['*soft*']);
    expect(typed('a _soft_ b', 'italic')).toEqual(['_soft_']);
  });

  it('reads a double delimiter as bold, not two italics', () => {
    expect(typed('**strong**', 'bold')).toEqual(['**strong**']);
    expect(typed('**strong**', 'italic')).toEqual([]);
  });

  it('formats strikethrough', () => {
    expect(typed('a ~~gone~~ b', 'strikethrough')).toEqual(['~~gone~~']);
  });

  it('formats inline code and dims both backticks', () => {
    expect(typed('use `npm i` now', 'code')).toEqual(['`npm i`']);
    expect(typed('use `npm i` now', 'syntax')).toEqual(['`', '`']);
  });

  it('leaves emphasis characters inside inline code alone', () => {
    expect(typed('`a * b * c`', 'italic')).toEqual([]);
  });

  it('formats a link and dims both delimiter runs', () => {
    const value = 'see [the docs](https://oxy.so) here';
    expect(typed(value, 'link')).toEqual(['[the docs](https://oxy.so)']);
    expect(typed(value, 'syntax')).toEqual(['[', '](https://oxy.so)']);
  });

  it('does not open emphasis on a lone asterisk in prose', () => {
    expect(typed('2 * 3 * 4 = 24', 'italic')).toEqual([]);
  });

  it('does not read an underscore inside a word as emphasis', () => {
    expect(typed('snake_case_name stays', 'italic')).toEqual([]);
  });
});

describe('parseArticleMarkdown — contract with the library', () => {
  it('returns ranges in nesting order: outer first, longest first on a tie', () => {
    const ranges = parseArticleMarkdown('# A **bold** heading');
    for (let i = 1; i < ranges.length; i += 1) {
      const previous = ranges[i - 1];
      const current = ranges[i];
      const ordered = previous.start < current.start
        || (previous.start === current.start && previous.length >= current.length);
      expect(ordered).toBe(true);
    }
  });

  it('never reports a range outside the text it was given', () => {
    const value = '# Title\n\n**bold** and `code` and [link](https://oxy.so)\n> quote';
    for (const range of parseArticleMarkdown(value)) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.start + range.length).toBeLessThanOrEqual(value.length);
      expect(range.length).toBeGreaterThan(0);
    }
  });

  it('answers an empty list for empty input rather than throwing', () => {
    expect(parseArticleMarkdown('')).toEqual([]);
  });

  it('leaves a plain-text article completely unformatted', () => {
    // The compatibility guarantee for every article written before this editor
    // existed: no delimiters, so no ranges, so it renders exactly as it did.
    const legacy = 'A plain article body.\n\nTwo paragraphs, no markdown at all.';
    expect(parseArticleMarkdown(legacy)).toEqual([]);
  });

  it('uses no Unicode property escape, which mobile Hermes rejects at runtime', () => {
    // The parser is a worklet, so it ships verbatim to Hermes. A `\p{...}` atom
    // would throw on EVERY native launch that touches the editor.
    expect(parseArticleMarkdown.toString()).not.toContain('\\p{');
    expect(parseArticleMarkdown.toString()).not.toContain('\\P{');
  });
});
