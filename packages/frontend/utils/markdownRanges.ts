import type { MarkdownRange } from '@expensify/react-native-live-markdown';

/**
 * The markdown grammar the article editor formats live.
 *
 * This is deliberately OUR parser rather than the library's bundled
 * `parseExpensiMark`. That one is a thin wrapper over `expensify-common`, whose
 * dependency closure is Expensify's app framework — jQuery, `react@16.12.0`,
 * `react-dom@16.12.0`, `localforage`, `clipboard`, and a `simply-deferred`
 * pulled from a raw GitHub URL: 26 packages and ~15 MB, measured by installing
 * it. A git-sourced dependency also makes every CI and Docker install depend on
 * github.com being reachable. None of that belongs in Mention to format an
 * article body, and `MarkdownTextInput` never imports it — `parser` is a
 * required prop precisely so the grammar is the host's choice.
 *
 * The contract is the library's: ranges are (start, length) offsets into the RAW
 * text; a `syntax` range marks delimiter characters so they render dimmed rather
 * than disappearing. Nothing is rewritten — the editor's value stays exactly
 * what the author typed, which is what keeps existing plain-text article bodies
 * safe (see `parseArticleMarkdown`).
 *
 * `'worklet'` because on native the parser runs on the LiveMarkdown worklet
 * runtime, not the JS thread. That forces two constraints, both deliberate:
 * everything is inlined into this one function (a worklet cannot call a
 * non-worklet helper), and no regex uses a `\p{...}` Unicode property escape,
 * which mobile Hermes rejects at runtime.
 */
export function parseArticleMarkdown(value: string): MarkdownRange[] {
  'worklet';

  const ranges: MarkdownRange[] = [];
  if (!value) return ranges;

  const push = (type: MarkdownRange['type'], start: number, length: number) => {
    if (length > 0) ranges.push({ type, start, length });
  };

  // ── Block structure, line by line ──────────────────────────────────────
  // Fenced code wins over everything inside it: a ``` block is verbatim, so no
  // inline pass may run over its contents.
  const fenced: { start: number; end: number }[] = [];
  const lines = value.split('\n');
  let offset = 0;
  let fenceStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

    if (line.trimStart().startsWith('```')) {
      if (fenceStart < 0) {
        fenceStart = lineStart;
      } else {
        const end = lineStart + line.length;
        push('pre', fenceStart, end - fenceStart);
        fenced.push({ start: fenceStart, end });
        fenceStart = -1;
      }
      continue;
    }
    if (fenceStart >= 0) continue;

    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading) {
      push('h1', lineStart, line.length);
      push('syntax', lineStart, heading[0].length);
      continue;
    }

    // The marker is dimmed on its own, so its offset is the INDENT's length —
    // not the whole match's, which also swallows the space after it.
    const quote = /^(\s*)>/.exec(line);
    if (quote) {
      push('blockquote', lineStart, line.length);
      push('syntax', lineStart + quote[1].length, 1);
    }
  }

  // An unterminated fence still formats to the end, so the block the author is
  // in the middle of typing looks like code rather than flickering plain.
  if (fenceStart >= 0) {
    push('pre', fenceStart, value.length - fenceStart);
    fenced.push({ start: fenceStart, end: value.length });
  }

  const insideFence = (index: number) => {
    for (let i = 0; i < fenced.length; i += 1) {
      if (index >= fenced[i].start && index < fenced[i].end) return true;
    }
    return false;
  };

  // ── Inline spans ───────────────────────────────────────────────────────
  // Inline code first: its content is verbatim too, so a `*` inside backticks
  // must not open an emphasis span.
  const code: { start: number; end: number }[] = [];
  const codePattern = /`([^`\n]+)`/g;
  let match = codePattern.exec(value);
  while (match !== null) {
    if (!insideFence(match.index)) {
      push('code', match.index, match[0].length);
      push('syntax', match.index, 1);
      push('syntax', match.index + match[0].length - 1, 1);
      code.push({ start: match.index, end: match.index + match[0].length });
    }
    match = codePattern.exec(value);
  }

  const verbatim = (index: number) => {
    if (insideFence(index)) return true;
    for (let i = 0; i < code.length; i += 1) {
      if (index >= code[i].start && index < code[i].end) return true;
    }
    return false;
  };

  // `[label](href)` — the label styles as a link, both delimiter runs dim.
  const linkPattern = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;
  match = linkPattern.exec(value);
  while (match !== null) {
    if (!verbatim(match.index)) {
      const labelLength = match[1].length;
      push('link', match.index, match[0].length);
      push('syntax', match.index, 1);
      push('syntax', match.index + 1 + labelLength, match[0].length - labelLength - 1);
    }
    match = linkPattern.exec(value);
  }

  // Emphasis. `**`/`__` before `*`/`_` so a bold run is not read as two italics,
  // and the delimiters are required to hug non-space so `a * b` stays prose.
  const emphasis: { pattern: RegExp; type: MarkdownRange['type']; marks: number }[] = [
    { pattern: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, type: 'bold', marks: 2 },
    { pattern: /(~~)(?=\S)([\s\S]*?\S)\1/g, type: 'strikethrough', marks: 2 },
    { pattern: /(?<![*\w])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![*\w])/g, type: 'italic', marks: 1 },
  ];

  for (let i = 0; i < emphasis.length; i += 1) {
    const rule = emphasis[i];
    match = rule.pattern.exec(value);
    while (match !== null) {
      if (!verbatim(match.index)) {
        push(rule.type, match.index, match[0].length);
        push('syntax', match.index, rule.marks);
        push('syntax', match.index + match[0].length - rule.marks, rule.marks);
      }
      match = rule.pattern.exec(value);
    }
  }

  // Outer spans must precede the spans they contain, so the renderer nests
  // rather than overwrites; ties break longest-first for the same reason.
  ranges.sort((a, b) => (a.start === b.start ? b.length - a.length : a.start - b.start));
  return ranges;
}
