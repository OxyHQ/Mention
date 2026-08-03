import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  countTextEntities,
  createTextEntityPattern,
  qualifyBareHandles,
  scanTextEntities,
  stripTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
  type TextEntity,
} from '../src/textEntities';

/** The kinds found, in order — the shape most assertions here care about. */
const kinds = (text: string, options = {}): string[] =>
  scanTextEntities(text, options).map((entity) => entity.kind);

/** The payloads found, in order. */
const values = (text: string, options = {}): string[] =>
  scanTextEntities(text, options).map((entity) => entity.value);

// --- hashtags: the bug this whole change exists for --------------------------

describe('hashtag', () => {
  it('links #BundesländerTurnier whole', () => {
    const [entity] = scanTextEntities('#BundesländerTurnier');
    expect(entity.kind).toBe('hashtag');
    expect(entity.value).toBe('BundesländerTurnier');
    expect(entity.raw).toBe('#BundesländerTurnier');
    expect(entity.end).toBe('#BundesländerTurnier'.length);
  });

  it('accepts a non-Latin script', () => {
    expect(values('#日本語 and #Привет')).toEqual(['日本語', 'Привет']);
  });

  it('keeps a Devanagari tag whole rather than cutting at its combining marks', () => {
    expect(values('#हिन्दी')).toEqual(['हिन्दी']);
  });

  it('does NOT match a tag that opens with a digit', () => {
    expect(kinds('#2026')).toEqual([]);
    expect(kinds('#1')).toEqual([]);
  });

  it('does NOT match a tag that opens with an underscore', () => {
    expect(kinds('#_private')).toEqual([]);
  });

  it('does NOT match emoji, which are symbols rather than letters', () => {
    expect(kinds('#🔥')).toEqual([]);
  });

  it('does not open a tag on a # inside a word, in any script', () => {
    // With the old ASCII boundary these two disagreed: `é` was "not a word
    // character", so `#Café#Bar` matched while `#Cafe#Bar` did not.
    expect(values('#Café#Bar')).toEqual(['Café#Bar'.slice(0, 4)]);
    expect(values('#Cafe#Bar')).toEqual(['Cafe#Bar'.slice(0, 4)]);
  });

  it('opens a tag at the very start of the text', () => {
    expect(values('#first tag')).toEqual(['first']);
  });
});

// --- precedence: the reason this is a scanner and not a bag of sources -------

describe('precedence', () => {
  it('a #fragment inside a URL belongs to the URL, not to a hashtag', () => {
    expect(kinds('see https://example.com/page#anchor now')).toEqual(['url']);
  });

  it('a $ inside a URL does not open a cashtag', () => {
    expect(kinds('https://example.com/a$AAPL')).toEqual(['url']);
  });

  it('turning a kind OFF does not let a lower-precedence kind claim its text', () => {
    // The filter applies AFTER precedence is decided, so dropping `url` must not
    // resurrect the `#anchor` inside it.
    expect(kinds('https://example.com/page#anchor', { kinds: ['hashtag'] })).toEqual([]);
  });

  it('puts the markup alternatives ahead of the sigil group', () => {
    // The ONE step of the assembly order that is load-bearing, asserted by name
    // so a reorder produces a failure that explains itself rather than a scatter
    // of unrelated reds.
    //
    // `[` is not a word character, so it is a legal leading boundary for a
    // sigil: the sigil group can match `@Ada` at the very same index 0 where
    // `[@Ada](ada)` starts, and whichever alternative is written first wins. Put
    // the sigil group first and every hydrated mention degrades to a bare handle
    // carrying the display NAME instead of a link to the account.
    const source = createTextEntityPattern().source;
    expect(source.indexOf('?<mdLabel>')).toBeLessThan(source.indexOf('?<handle>'));
    expect(source.indexOf('?<mentionId>')).toBeLessThan(source.indexOf('?<handle>'));

    // The behaviour that order buys.
    expect(scanTextEntities('[@Ada](ada)').map((entity) => entity.kind)).toEqual([
      'mentionDisplay',
    ]);
  });

  it('a mention target that looks like a URL stays part of the mention', () => {
    const found = scanTextEntities('[@Bob](https://example.com/bob)');
    expect(found.map((e) => e.kind)).toEqual(['mentionDisplay']);
    expect(found[0].value).toBe('https://example.com/bob');
  });
});

// --- mention forms -----------------------------------------------------------

describe('mention placeholder', () => {
  it('captures the id', () => {
    const [entity] = scanTextEntities('hi [mention:abc123] there');
    expect(entity.kind).toBe('mentionPlaceholder');
    expect(entity.value).toBe('abc123');
    expect(entity.raw).toBe('[mention:abc123]');
  });

  it('rejects an id containing whitespace', () => {
    // The two definitions that used to exist disagreed here. An id never
    // contains whitespace, and the loose form let a hand-typed placeholder be
    // consumed by the federation linkifier while being unable to reconcile
    // against any authorized id.
    expect(kinds('[mention:foo bar]')).toEqual([]);
  });
});

describe('mention display', () => {
  it('splits the label from the target', () => {
    const [entity] = scanTextEntities('hi [@Ada Lovelace](ada) there');
    expect(entity.kind).toBe('mentionDisplay');
    expect(entity.label).toBe('Ada Lovelace');
    expect(entity.value).toBe('ada');
  });

  it('handles a federated handle target', () => {
    const [entity] = scanTextEntities('[@Bob](bob@remote.social)');
    expect(entity.value).toBe('bob@remote.social');
  });

  it('leaves a plain markdown link alone — it is not a mention', () => {
    expect(kinds('[a label](https://example.com)')).toEqual(['url']);
  });
});

// --- URLs --------------------------------------------------------------------

describe('url', () => {
  it('matches a bare www. form by default', () => {
    expect(values('visit www.example.com today')).toEqual(['www.example.com']);
  });

  it('does not match a bare www. form when bareWww is off', () => {
    expect(kinds('visit www.example.com today', { bareWww: false })).toEqual([]);
    expect(values('visit https://example.com', { bareWww: false })).toEqual(['https://example.com']);
  });

  it('runs to whitespace by default, swallowing a following tag', () => {
    expect(values('https://example.com/a<br>')).toEqual(['https://example.com/a<br>']);
  });

  it('stops at < in html mode', () => {
    expect(values('https://example.com/a<br>', { urlTerminator: 'html' })).toEqual([
      'https://example.com/a',
    ]);
  });
});

describe('trimUrlTrailingPunctuation', () => {
  it('gives a sentence-ending full stop back to the sentence', () => {
    expect(trimUrlTrailingPunctuation('https://x.com.')).toEqual({
      url: 'https://x.com',
      trailing: '.',
    });
  });

  it('trims an unbalanced closing paren', () => {
    expect(trimUrlTrailingPunctuation('https://z.com)').url).toBe('https://z.com');
  });

  it('keeps a BALANCED closing paren, which belongs to the URL', () => {
    const raw = 'https://en.wikipedia.org/wiki/Foo_(disambiguation)';
    expect(trimUrlTrailingPunctuation(raw)).toEqual({ url: raw, trailing: '' });
  });

  it('keeps the balanced bracket closing an IPv6 host', () => {
    // The frontend used to trim `]` unconditionally, which truncates this to
    // `http://[::1` — a URL that no longer parses.
    expect(trimUrlTrailingPunctuation('http://[::1]')).toEqual({
      url: 'http://[::1]',
      trailing: '',
    });
    expect(() => new URL(trimUrlTrailingPunctuation('http://[::1]').url)).not.toThrow();
  });

  it('trims an unbalanced closing bracket', () => {
    expect(trimUrlTrailingPunctuation('https://x.com]').url).toBe('https://x.com');
  });

  it('trims a trailing quote', () => {
    expect(trimUrlTrailingPunctuation('https://x.com"').url).toBe('https://x.com');
  });
});

describe('toOpenableUrl', () => {
  it('leaves a scheme-bearing URL alone', () => {
    expect(toOpenableUrl('http://x.com')).toBe('http://x.com');
    expect(toOpenableUrl('https://x.com')).toBe('https://x.com');
  });

  it('supplies https for a bare www. form', () => {
    expect(toOpenableUrl('www.x.com')).toBe('https://www.x.com');
  });

  it('does not mistake a host that merely starts with "http" for a scheme', () => {
    // The old implementation tested `startsWith('http')`, so this host was left
    // scheme-less and unopenable.
    expect(toOpenableUrl('www.httpbin.org')).toBe('https://www.httpbin.org');
    expect(toOpenableUrl('httpbin.org')).toBe('https://httpbin.org');
  });
});

// --- cashtags ----------------------------------------------------------------

describe('cashtag', () => {
  it('matches a ticker and a class suffix', () => {
    expect(values('$AAPL and $BRK.B')).toEqual(['AAPL', 'BRK.B']);
  });

  it('does not match a price or a lower-case word', () => {
    expect(kinds('$100 and $ave')).toEqual([]);
  });

  it('does not open on a $ inside a word', () => {
    expect(kinds('US$5')).toEqual([]);
  });
});

// --- bare handles -----------------------------------------------------------

describe('bareHandle', () => {
  it('matches a handle typed into prose', () => {
    expect(values('hi @alice there', { kinds: ['bareHandle'] })).toEqual(['alice']);
  });

  it('matches at the very start of the text', () => {
    expect(values('@alice speaks', { kinds: ['bareHandle'] })).toEqual(['alice']);
  });

  /**
   * `.` and `-` are IN the handle class because a handle can contain them, but
   * it cannot END with one — and prose puts a full stop straight after a handle
   * constantly. Seen live in a synced profile bio: "Now building
   * @thinkymachines. Previously CTO @openai" yielded the handle
   * `thinkymachines.`, sentence punctuation and all, which every consumer then
   * linkified, stored or qualified as if somebody had typed it.
   */
  it('does not take the sentence punctuation that follows a handle', () => {
    expect(values('Now building @thinkymachines. Previously CTO @openai', { kinds: ['bareHandle'] }))
      .toEqual(['thinkymachines', 'openai']);
    expect(values('@other- and @name.', { kinds: ['bareHandle'] })).toEqual(['other', 'name']);
  });

  /**
   * The other half, and the reason this is a trailing-only trim rather than
   * dropping `.` from the class: an atproto handle IS a dotted DNS name, so a
   * rule that removed interior dots would break every Bluesky handle we hold.
   */
  it('keeps the dots INSIDE a handle that legitimately has them', () => {
    expect(values('@alice.bsky.social posts', { kinds: ['bareHandle'] })).toEqual(['alice.bsky.social']);
    expect(values('@some-name here', { kinds: ['bareHandle'] })).toEqual(['some-name']);
  });

  it('yields nothing for a sigil followed only by punctuation', () => {
    expect(values('@... nothing', { kinds: ['bareHandle'] })).toEqual([]);
    expect(values('@-', { kinds: ['bareHandle'] })).toEqual([]);
  });

  /**
   * `raw`/`start`/`end` describe the span a caller REPLACES, so a trim that
   * shortened the value while leaving the span long would make every rewrite
   * eat the following character. Asserted directly because the failure would
   * show up as corrupted text at a call site, not here.
   */
  it('reports a span that covers exactly the trimmed handle', () => {
    const text = 'Now building @thinkymachines. Previously';
    const [entity] = scanTextEntities(text, { kinds: ['bareHandle'] });
    expect(text.slice(entity.start, entity.end)).toBe('@thinkymachines');
    expect(entity.raw).toBe('@thinkymachines');
  });

  it('does NOT swallow an email-shaped someone@instance.tld', () => {
    // The hazard `termExtraction` documents: the local part is a continuation
    // character, so no handle opens at that `@`. Left unguarded, trending
    // harvested this instance's own domain out of `@someone@mention.earth`.
    expect(kinds('someone@instance.tld')).toEqual([]);
    expect(kinds('mail someone@instance.tld now')).toEqual([]);
    expect(kinds('foo.bar@instance.tld')).toEqual([]);
  });

  it('takes only the local part of a two-part federated handle', () => {
    // The `@user@host` form is a DIFFERENT entity, owned by `termExtraction`
    // whose strip order is incident-documented. `@` is not in the handle class,
    // so the run ends at the second one and the host cannot open its own.
    expect(values('hi @user@host.tld')).toEqual(['user']);
  });

  it('keeps a non-Latin handle whole rather than cutting at a combining mark', () => {
    expect(values('@हिन्दी', { kinds: ['bareHandle'] })).toEqual(['हिन्दी']);
  });

  it('loses to a URL, so a path segment is not read as a handle', () => {
    expect(kinds('https://x.com/@alice')).toEqual(['url']);
  });

  it('loses to the display-mention markup', () => {
    expect(kinds('[@Ada](ada)')).toEqual(['mentionDisplay']);
  });
});

// --- spans -------------------------------------------------------------------

describe('spans', () => {
  it('start/end bracket the entity itself, excluding the preceding boundary', () => {
    const text = 'hello #tag world';
    const [entity] = scanTextEntities(text);
    expect(text.slice(entity.start, entity.end)).toBe('#tag');
    expect(entity.raw).toBe('#tag');
  });

  it('partitions a mixed body so the plain runs can be rebuilt exactly', () => {
    const text = 'hi [@Ada](ada) see https://x.com about #tag and $AAPL';
    let cursor = 0;
    let rebuilt = '';
    for (const entity of scanTextEntities(text)) {
      rebuilt += text.slice(cursor, entity.start) + entity.raw;
      cursor = entity.end;
    }
    rebuilt += text.slice(cursor);
    expect(rebuilt).toBe(text);
  });

  it('finds every kind in one ordered pass', () => {
    expect(
      kinds('[@Ada](ada) [mention:x1] https://x.com @bob #tag $AAPL'),
    ).toEqual([
      'mentionDisplay',
      'mentionPlaceholder',
      'url',
      'bareHandle',
      'hashtag',
      'cashtag',
    ]);
  });
});

// --- strip / count -----------------------------------------------------------

describe('stripTextEntities', () => {
  it('replaces entities with a space so neighbouring words do not fuse', () => {
    // Deleting outright would leave `alphabeta` — one token nobody wrote.
    expect(stripTextEntities('alpha #tag beta', { kinds: ['hashtag'] })).toBe('alpha   beta');
  });

  it('leaves a non-hashtag # run in place as prose', () => {
    expect(stripTextEntities('ran #2026 miles', { kinds: ['hashtag'] })).toBe('ran #2026 miles');
  });

  it('honours a custom replacement', () => {
    expect(stripTextEntities('a #tag b', { kinds: ['hashtag'], replacement: '' })).toBe('a  b');
  });
});

describe('countTextEntities', () => {
  it('tallies by kind', () => {
    const found = scanTextEntities('#a #b https://x.com');
    expect(countTextEntities(found, 'hashtag')).toBe(2);
    expect(countTextEntities(found, 'url')).toBe(1);
    expect(countTextEntities(found, 'cashtag')).toBe(0);
  });
});

// --- misuse ------------------------------------------------------------------

describe('misuse', () => {
  it('returns nothing for empty text', () => {
    expect(scanTextEntities('')).toEqual([]);
  });

  it('throws rather than silently matching nothing when no kinds are selected', () => {
    // An empty alternation compiles to a regex that matches the empty string
    // everywhere; failing loudly is the difference between a caught mistake and
    // a scan that quietly finds no entities forever.
    expect(() => scanTextEntities('#tag', { kinds: [] })).toThrow(/selected no entity kinds/);
  });

  it('does not share lastIndex between scans', () => {
    const text = '#one #two';
    expect(values(text)).toEqual(['one', 'two']);
    expect(values(text)).toEqual(['one', 'two']);
  });
});

// --- Hermes safety (the gate) ------------------------------------------------

describe('Hermes safety', () => {
  // This module is built at module load inside the React Native bundle, and
  // Hermes has Unicode property escapes compiled OUT — every `\p{…}` atom throws
  // at RUNTIME, so one here is a crash at boot. Neither `hermesc` nor any V8 run
  // reproduces it, which is why a text scan is the check.
  const PROPERTY_ESCAPE = /\\[pP]\{/;
  const DIST = join(import.meta.dir, '..', 'dist');

  /**
   * Every BUILT file the scanner actually pulls in, followed transitively from
   * `dist/textEntities.js`.
   *
   * Walking the real closure rather than naming files: a hardcoded list keeps
   * passing when a future edit introduces a NEW dependency carrying a property
   * escape, which is precisely the hole a source grep leaves. This scans what
   * ships — `dist/`, the artefact Metro resolves for this package — so a
   * property escape anywhere the scanner can reach is caught wherever it was
   * written.
   */
  const scannerClosure = (): string[] => {
    const seen = new Set<string>();
    const queue = ['textEntities.js'];
    while (queue.length > 0) {
      const relative = queue.pop() as string;
      if (seen.has(relative)) continue;
      seen.add(relative);
      const contents = readFileSync(join(DIST, relative), 'utf8');
      for (const match of contents.matchAll(/require\("(\.[^"]+)"\)/g)) {
        queue.push(`${match[1].replace(/^\.\//, '')}.js`);
      }
    }
    return [...seen];
  };

  it('no built file the scanner reaches carries a property escape', () => {
    // This gate reads the BUILT output, so it needs one. A root `bun install`
    // builds it (`build:shared-types`), but a fresh checkout that skips that —
    // or anyone running the suite before a first build — used to get a raw
    // ENOENT from deep inside the traversal, which reads as "the gate is
    // broken" rather than "there is nothing to gate yet". Say which it is.
    expect(
      existsSync(join(DIST, 'textEntities.js')),
      'shared-types dist/ is missing — run `bun run build` before this suite',
    ).toBe(true);

    const closure = scannerClosure();

    // Vacuity floor: a traversal that silently found nothing would pass the
    // assertion below without having looked at anything.
    expect(closure.length).toBeGreaterThanOrEqual(3);
    expect(closure).toContain('hashtagRanges.generated.js');

    const offenders = closure.flatMap((relative) =>
      readFileSync(join(DIST, relative), 'utf8')
        .split('\n')
        .map((line, n) => ({ relative, line, n: n + 1 }))
        .filter(({ line }) => PROPERTY_ESCAPE.test(line))
        // Print the whole offending line, never a truncated capture group.
        .map(({ line, n }) => `${relative}:${n}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the compiled pattern contains no property escape', () => {
    // The strongest check: the exact string handed to `new RegExp`, whichever
    // file each fragment came from.
    expect(PROPERTY_ESCAPE.test(createTextEntityPattern().source)).toBe(false);
  });

  it('every option combination compiles under the u flag', () => {
    for (const urlTerminator of ['whitespace', 'html'] as const) {
      for (const bareWww of [true, false]) {
        const pattern = createTextEntityPattern({ urlTerminator, bareWww });
        expect(pattern.flags).toContain('u');
        expect(PROPERTY_ESCAPE.test(pattern.source)).toBe(false);
      }
    }
  });

  it('the shipped source writes no property-escape notation, even in prose', () => {
    // The gate is a flat text scan, so the notation is banned in comments too —
    // a gate that needs a parser to tell code from prose is one that eventually
    // gets an exception carved into it.
    const relative = 'src/textEntities.ts';
    const contents = readFileSync(join(import.meta.dir, '..', relative), 'utf8');
    const offenders = contents
      .split('\n')
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => PROPERTY_ESCAPE.test(line))
      .map(({ n, line }) => `${relative}:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  // WHAT THIS DOES NOT COVER, stated plainly rather than left to be assumed:
  // the APP bundle. A real `expo export --platform android` was checked and
  // carries property escapes that are NOT ours and that this can never gate —
  // zod ships `_emoji` as a string constant, and another dependency ships
  // `[\p{L}\p{N}_@]`. Both are lazily compiled rather than module-load regex
  // literals, so neither is a boot crash, but it means "zero escapes in the
  // bundle" is not an assertion anyone can hold. The closure walk above is the
  // strongest honest version: zero in everything THIS package ships.
  // `bun run check:bundle-escapes` re-runs the real-bundle attribution.
});

// --- shape -------------------------------------------------------------------

describe('TextEntity shape', () => {
  it('carries a label only for a display mention', () => {
    const found: TextEntity[] = scanTextEntities('[@Ada](ada) #tag https://x.com');
    expect(found[0].label).toBe('Ada');
    expect(found[1].label).toBeUndefined();
    expect(found[2].label).toBeUndefined();
  });
});

/**
 * A federated actor's own words carry handles that only mean something next to
 * the network they were written on. Mira Murati's synced bio read "Now building
 * @thinkymachines. Previously CTO @openai" — both accounts on X, both rendered
 * here as if they were local names.
 */
describe('qualifyBareHandles', () => {
  it('qualifies the bare handles in a real synced bio', () => {
    expect(qualifyBareHandles('Now building @thinkymachines. Previously CTO @openai', 'x.com'))
      .toBe('Now building @thinkymachines@x.com. Previously CTO @openai@x.com');
  });

  /**
   * The case that makes appending unsafe. The scanner treats a two-part handle
   * as an entity it does not own, so `@alice@mastodon.social` arrives as the
   * bare `@alice`; appending without looking would yield
   * `@alice@x.com@mastodon.social` — a handle naming nobody, written into the
   * database.
   */
  it('leaves an already-qualified handle exactly as it is', () => {
    expect(qualifyBareHandles('ping @alice@mastodon.social ok', 'x.com'))
      .toBe('ping @alice@mastodon.social ok');
    expect(qualifyBareHandles('@a@b.com and @c', 'x.com'))
      .toBe('@a@b.com and @c@x.com');
  });

  it('never touches a handle inside a URL, or an email', () => {
    expect(qualifyBareHandles('see https://x.com/@handle now', 'x.com'))
      .toBe('see https://x.com/@handle now');
    expect(qualifyBareHandles('mail nate@oxy.so please', 'x.com'))
      .toBe('mail nate@oxy.so please');
  });

  it('returns the original string when there is nothing to qualify', () => {
    const untouched = 'no handles here at all';
    expect(qualifyBareHandles(untouched, 'x.com')).toBe(untouched);
    expect(qualifyBareHandles('', 'x.com')).toBe('');
  });

  it('does nothing without a domain, rather than writing a trailing @', () => {
    expect(qualifyBareHandles('hi @alice', '')).toBe('hi @alice');
    expect(qualifyBareHandles('hi @alice', '   ')).toBe('hi @alice');
  });

  it('lower-cases the domain it appends but never the handle', () => {
    // The handle's case is the actor's own and is displayed; the domain is a
    // hostname and is not.
    expect(qualifyBareHandles('hi @OpenAI', 'X.com')).toBe('hi @OpenAI@x.com');
  });

  it('is idempotent, so a re-sync cannot stack domains', () => {
    const once = qualifyBareHandles('CTO @openai', 'x.com');
    expect(qualifyBareHandles(once, 'x.com')).toBe(once);
  });

  it('keeps the punctuation that follows a handle', () => {
    // The trailing-dot trim above is what makes this work: without it the
    // sentence's period ends up INSIDE the qualified handle.
    expect(qualifyBareHandles('building @thinkymachines. done', 'x.com'))
      .toBe('building @thinkymachines@x.com. done');
  });
});
