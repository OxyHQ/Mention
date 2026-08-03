import { describe, it, expect } from 'vitest';
import {
  deriveTrendLabel,
  fallbackTrendLabel,
  TREND_LABEL_VERSION,
} from '../services/trending/trendLabeling';

/**
 * Deterministic trend labelling — no model, no key, no network.
 *
 * The two behaviours worth pinning are the ones that make a derived label good
 * enough to be the default: casing read back from the corpus (so `fifa` renders
 * as `FIFA` without anything knowing what an acronym is), and a shared phrase
 * replacing the term when most posts agree on one.
 *
 * The excerpts below are real posts from the trends they name, so a change that
 * looks fine in the abstract but ruins a real case fails here.
 */

/** The Orioles/Kremer trade — the term is the team, the story is the player. */
const ORIOLES_POSTS = [
  'Value wise I think it is a good trade for the Orioles I just hope there is a plan to replace Dean Kremer',
  'The Twins are adding pitching depth, picking up Dean Kremer from the Orioles. Kremer is 1-4 this year.',
  'Jhomnardo Reyes is going to the Orioles for Dean Kremer, per source.',
  'Orioles trading Dean Kremer to Minnesota Twins',
];

/** A FIFA corruption story — nobody tagged it, everybody shouted the acronym. */
const FIFA_POSTS = [
  '"That was too sketchy a plan even for FIFA" is not a sentence I thought could be formed.',
  'I feel good that the Europeans squashed the FIFA corruption plans.',
  'Head FIFA corruptoid apparently going with "so that one went pretty well, right?"',
  'It is looking like Infantino could get the boot from FIFA.',
];

/** A community hashtag — mixed casing, and the canonical form is the tag. */
const FRIGHTCLUB_POSTS = [
  'My mom asked me later if Cheryl was impregnated by a tree #frightclub',
  'If I hear that voice outside my window I am not going to the window #FrightClub',
  'Now THAT is a Kandarian Dagger, not that little shiv #FrightClub',
  'HAPPY BIRTHDAY ASHY SLASHY! A most excellent #FrightClub friend and fiend.',
];

describe('deriveTrendLabel — casing comes from the corpus', () => {
  it('renders an acronym the way people wrote it, not title-cased', () => {
    expect(deriveTrendLabel({ term: 'fifa', excerpts: FIFA_POSTS }).displayName).toBe('FIFA');
  });

  it('picks the MAJORITY spelling of a mixed-case tag', () => {
    // Three posts say `#FrightClub`, one says `#frightclub`.
    expect(deriveTrendLabel({ term: 'frightclub', excerpts: FRIGHTCLUB_POSTS }).displayName)
      .toBe('FrightClub');
  });

  it('strips the hashtag marker from the surface form it keeps', () => {
    expect(deriveTrendLabel({ term: 'frightclub', excerpts: FRIGHTCLUB_POSTS }).displayName)
      .not.toContain('#');
  });

  it('renders a multi-word name as written', () => {
    const posts = [
      'Todd Blanche testified this morning about the memo.',
      'Everyone is talking about Todd Blanche again.',
    ];
    expect(deriveTrendLabel({ term: 'todd blanche', excerpts: posts }).displayName)
      .toBe('Todd Blanche');
  });
});

describe('deriveTrendLabel — a corpus spelling has to earn its place', () => {
  it('does NOT shout back a word the posts happen to shout', () => {
    // Live batch, 2026-08-01: the term `politics` shipped as "POLITICS",
    // because its commonest appearance is inside an all-caps hashtag tail.
    const posts = ['#POLITICS today', 'more #POLITICS', 'the #POLITICS of it'];
    expect(deriveTrendLabel({ term: 'politics', excerpts: posts }).displayName).toBe('Politics');
  });

  it('still keeps a genuine acronym, which is short enough not to read as shouting', () => {
    const posts = ['FIFA again', 'FIFA once more', 'and FIFA'];
    expect(deriveTrendLabel({ term: 'fifa', excerpts: posts }).displayName).toBe('FIFA');
  });

  it('title-cases a term nobody ever capitalised', () => {
    // Live batch: `mention` shipped lower case because it is written
    // mid-sentence — the corpus form carried nothing worth preferring.
    const posts = ['i will mention it later', 'did you mention that', 'a mention of it'];
    expect(deriveTrendLabel({ term: 'mention', excerpts: posts }).displayName).toBe('Mention');
  });
});

describe('deriveTrendLabel — a shared phrase beats the term', () => {
  it('names the trend after the phrase most posts share', () => {
    // The term is `orioles`; what the posts are ABOUT is Dean Kremer.
    expect(deriveTrendLabel({ term: 'orioles', excerpts: ORIOLES_POSTS }).displayName)
      .toBe('Dean Kremer');
  });

  it('keeps the term when no phrase reaches a majority', () => {
    // Each post shares a different phrase with no other, so none is the story.
    const posts = [
      'orioles beat the yankees today',
      'orioles signed a new catcher',
      'orioles stadium renovation approved',
      'orioles minor league affiliate moving',
    ];
    expect(deriveTrendLabel({ term: 'orioles', excerpts: posts }).displayName).toBe('Orioles');
  });

  it('never renames a trend after a phrase that merely restates it', () => {
    const posts = [
      'the orioles trade is done, orioles trade confirmed',
      'orioles trade rumours were true, orioles trade done',
      'another orioles trade for the orioles trade pile',
    ];
    expect(deriveTrendLabel({ term: 'orioles', excerpts: posts }).displayName).toBe('Orioles');
  });

  it('counts a phrase once per post, so one loud post cannot outvote the rest', () => {
    // Written as people write names — the extractor now requires a phrase to
    // NAME something, which is the same rule that keeps `love` and `hope` out
    // of the trending list.
    const posts = [
      'sponsored link sponsored link sponsored link sponsored link sponsored link',
      'i think Dean Kremer is having a rough season',
      'apparently Dean Kremer traded again',
      'so Dean Kremer to the twins',
    ];
    expect(deriveTrendLabel({ term: 'orioles', excerpts: posts }).displayName).toBe('Dean Kremer');
  });
});

describe('deriveTrendLabel — category', () => {
  it('maps a rule-classifier slug onto its trend category', () => {
    // `politics`, not `news`: `senate` carries all three posts and "breaking
    // news" carries one. This fixture expected `news` while the category was
    // the FIRST slug the classifier returned — which is its rule array's line
    // order — so it was pinning the tiebreak that filed `Trump` under Science.
    const posts = ['breaking news the senate voted today', 'the senate bill passed', 'senate news'];
    expect(deriveTrendLabel({ term: 'senate', excerpts: posts }).category).toBe('politics');
  });

  it('renames the classifier vocabulary to the client-facing one', () => {
    // The classifier says `gaming`; the taxonomy a reader sees says `video-games`.
    const posts = ['the new video game release is great', 'gaming all night', 'video game leaks'];
    expect(deriveTrendLabel({ term: 'console', excerpts: posts }).category).toBe('video-games');
  });

  it('collapses several classifier slugs onto one category', () => {
    const posts = ['new ai model released', 'machine learning progress', 'ai everywhere'];
    expect(deriveTrendLabel({ term: 'openai', excerpts: posts }).category).toBe('tech');
  });

  it('degrades to other when nothing in the taxonomy fits', () => {
    const posts = ['blorp blorp blorp', 'blorp again blorp', 'more blorp blorp'];
    expect(deriveTrendLabel({ term: 'blorp', excerpts: posts }).category).toBe('other');
  });

  // The classifier is KEYWORD-based, so a story can be unmistakably about a
  // sport to a human and still carry none of its words. That costs the category
  // and nothing else — the label, the feed and the ranking are unaffected — and
  // the honest answer is `other`, which renders as no category rather than a
  // wrong one. Pinned so nobody reads the mapping above as a claim of coverage.
  it('answers other for a sports story that never uses a sport word', () => {
    expect(deriveTrendLabel({ term: 'orioles', excerpts: ORIOLES_POSTS }).category).toBe('other');
  });
});

describe('deriveTrendLabel — no evidence', () => {
  it('title-cases the term when there are no excerpts at all', () => {
    expect(deriveTrendLabel({ term: 'todd blanche', excerpts: [] })).toEqual({
      displayName: 'Todd Blanche',
      category: 'other',
    });
  });

  it('title-cases the term when every excerpt is blank', () => {
    expect(deriveTrendLabel({ term: 'fifa', excerpts: ['', '   '] }).displayName).toBe('Fifa');
  });

  it('title-cases a term that never appears in the bodies (tag-only arrival)', () => {
    const posts = ['a post that carried the tag in its tag array, never in its text'];
    expect(deriveTrendLabel({ term: 'frightclub', excerpts: posts }).displayName).toBe('Frightclub');
  });

  it('is total — an empty term still answers', () => {
    expect(deriveTrendLabel({ term: '   ', excerpts: FIFA_POSTS }).displayName).toBeTruthy();
  });
});

describe('deriveTrendLabel — determinism', () => {
  it('does not depend on the order the posts arrive in', () => {
    const forward = deriveTrendLabel({ term: 'orioles', excerpts: ORIOLES_POSTS });
    const reversed = deriveTrendLabel({ term: 'orioles', excerpts: [...ORIOLES_POSTS].reverse() });
    expect(forward).toEqual(reversed);
  });
});

describe('fallbackTrendLabel', () => {
  it('title-cases the term and files it under other', () => {
    expect(fallbackTrendLabel('todd blanche')).toEqual({
      displayName: 'Todd Blanche',
      category: 'other',
    });
  });
});

describe('deriveCategory — evidence, not file order', () => {
  it('files a term under the topic MOST of its posts support', () => {
    // `Trump` was filed under Science on the live list: one post said "climate
    // change" and the science rule sits two lines above the politics rule in
    // the taxonomy, so the first-match tiebreak was really the file's line
    // order.
    const label = deriveTrendLabel({
      term: 'trump',
      excerpts: [
        'the election result is disputed in congress',
        'senate hearing on the campaign trail today',
        'a post about climate change and the election',
      ],
    });

    expect(label.category).toBe('politics');
  });

  it('lets the term its own mapping outrank whatever its posts mention', () => {
    // The term is the most on-topic token there is; the prose is context
    // around it, and a trend on `esports` must not be filed under Finance
    // because its posts discuss the market.
    const label = deriveTrendLabel({
      term: 'esports',
      excerpts: [
        'the stock market reaction to inflation was brutal',
        'the stock market reaction to inflation was brutal',
      ],
    });

    expect(label.category).not.toBe('finance');
  });
});

describe('TREND_LABEL_VERSION guards the labels it stamps', () => {
  /*
   * A stored label is REUSED for the life of a run unless its version differs,
   * so a rules fix reaches nothing already running until the version moves.
   * Forgetting that has now shipped twice: `POLITICS` survived the fix that
   * would have written `Politics`, and `US` stayed filed under Science after
   * the fix that would have written `other`.
   *
   * The rule lived in a doc comment both times. This table is the gate: change
   * what labelling produces and it fails, and the only way to make it pass is
   * to update the expectation — at which point the version below is right
   * there, in the same file, failing too.
   */
  const CASES: ReadonlyArray<[string, string[], string, string]> = [
    ['orioles', ['the orioles won again', 'orioles bullpen is set'], 'Orioles', 'other'],
    [
      'senate',
      ['breaking news the senate voted today', 'the senate bill passed', 'senate news'],
      'Senate',
      'politics',
    ],
    ['esports', ['a big esports final tonight'], 'Esports', 'video-games'],
    // The one case where the two branches DISAGREE, and therefore the only one
    // that can tell them apart: `climate` maps to Science on its own, while its
    // posts here are about an election. Without it the table passed with the
    // term-mapping branch deleted entirely — a gate that could not fail for the
    // rule it was written to guard.
    [
      'climate',
      ['the election result is disputed in congress', 'senate campaign trail'],
      'Climate',
      'science',
    ],
  ];

  it.each(CASES)('labels %s deterministically', (term, excerpts, displayName, category) => {
    const label = deriveTrendLabel({ term, excerpts });
    expect(label.displayName).toBe(displayName);
    expect(label.category).toBe(category);
  });

  it('is at v3 — bump it in the same change that alters the table above', () => {
    expect(TREND_LABEL_VERSION).toBe(3);
  });
});
