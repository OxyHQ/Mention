import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ONE AUTHORITY ON WHETHER A CHANNEL NAMES ITS WRITERS.
 *
 * Two surfaces ask this question — the post byline ("name the writer of THIS
 * post") and the channel's writers list ("name everyone who has written for this
 * channel") — and the whole reason this module exists is that two answers is one
 * answer too many. A disagreement here is not a rendering inconsistency: one of
 * the two would be publishing a name the channel never consented to publish, and
 * that is not recoverable by a later request that gets it right.
 *
 * So this file pins two different things:
 *
 *  1. the DECISION — fail-closed at every step, including the `=== true` read
 *     that no `true` / `false` / absent fixture can distinguish from a loose one;
 *  2. the SINGLENESS of it — a source scan that fails if any other module starts
 *     reading `signPosts` for itself.
 */

const CHANNEL_ID = 'oxy-channel';
const OTHER_CHANNEL_ID = 'oxy-channel-2';

const { loadChannelSignPostsByIds } = vi.hoisted(() => ({
  loadChannelSignPostsByIds: vi.fn(),
}));

vi.mock('../../db/userProfile/userSettingsRepository', () => ({
  loadChannelSignPostsByIds: (...args: unknown[]) => loadChannelSignPostsByIds(...args),
}));

/**
 * The loader answers a Map, and the mock is typed loosely ON PURPOSE — see the
 * truthy-non-boolean case below for why a fixture has to be able to hold a value
 * the column's own type forbids.
 */
function signPostsRows(entries: Array<[string, unknown]>): Map<string, unknown> {
  return new Map(entries);
}

import { disclosesWriters, loadSigningChannelIds } from '../../services/channelWriterDisclosure';

describe('loadSigningChannelIds', () => {
  beforeEach(() => {
    loadChannelSignPostsByIds.mockReset();
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([]));
  });

  it('holds an account whose settings row says signPosts is true', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([[CHANNEL_ID, true]]));

    const signing = await loadSigningChannelIds([CHANNEL_ID]);

    expect([...signing]).toEqual([CHANNEL_ID]);
  });

  it('omits an account that has not opted in', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([[CHANNEL_ID, false]]));

    expect((await loadSigningChannelIds([CHANNEL_ID])).has(CHANNEL_ID)).toBe(false);
  });

  it('omits an account with no settings row at all', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([]));

    expect((await loadSigningChannelIds([CHANNEL_ID])).has(CHANNEL_ID)).toBe(false);
  });

  it('omits an account whose row is NULL — the shape that says "not a channel"', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([[CHANNEL_ID, null]]));

    expect((await loadSigningChannelIds([CHANNEL_ID])).has(CHANNEL_ID)).toBe(false);
  });

  /**
   * The fixture that tells `signPosts === true` from `Boolean(signPosts)`.
   *
   * Every other case in this file is `true`, `false` or absent, and a loose read
   * agrees with a strict one on all three — so without a truthy NON-boolean,
   * dropping the `=== true` leaves the whole suite green. Mutation-verified on
   * the Postgres loader: relaxing the read to `Boolean(...)` reddens exactly
   * these cases and nothing else.
   *
   * WHAT CHANGED WITH THE PORT, because the honest version is weaker than the
   * one this comment used to make. On Mongo these were REACHABLE values — a form
   * post or a hand-edited document really could store `"false"`. `user_settings.
   * channel_account_sign_posts` is a typed `boolean` column, so Postgres cannot
   * hand back any of them, and the values that ARE reachable (`true`, `false`,
   * `null`, no row) are ones a strict and a loose read agree on. So this case no
   * longer guards a live defect: it pins the LOADER'S CONTRACT, and it is the
   * only thing standing between a future loader change — a raw-SQL read, a JSON
   * column, a cache that rehydrates from a string — and a silent disclosure.
   * That is worth keeping precisely because nothing else in the stack would
   * notice; it is defence in depth, and it should not be described as more.
   */
  it.each([{ value: 'false' }, { value: 'true' }, { value: 1 }, { value: {} }])(
    'refuses a truthy non-boolean signPosts ($value)',
    async ({ value }: { value: unknown }) => {
      loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([[CHANNEL_ID, value]]));

      expect((await loadSigningChannelIds([CHANNEL_ID])).has(CHANNEL_ID)).toBe(false);
    },
  );

  it('fails CLOSED when the settings lookup throws', async () => {
    loadChannelSignPostsByIds.mockRejectedValue(new Error('postgres is down'));

    expect([...(await loadSigningChannelIds([CHANNEL_ID]))]).toEqual([]);
  });

  it('asks nothing when there are no candidates', async () => {
    expect([...(await loadSigningChannelIds([]))]).toEqual([]);
    expect(loadChannelSignPostsByIds).not.toHaveBeenCalled();
  });

  it('drops empty and duplicate candidates before querying', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(signPostsRows([]));

    await loadSigningChannelIds([CHANNEL_ID, CHANNEL_ID, '']);

    expect(loadChannelSignPostsByIds).toHaveBeenCalledTimes(1);
    expect(loadChannelSignPostsByIds).toHaveBeenCalledWith([CHANNEL_ID]);
  });

  it('answers a whole page of channels in ONE query, per channel', async () => {
    loadChannelSignPostsByIds.mockResolvedValue(
      signPostsRows([
        [CHANNEL_ID, true],
        [OTHER_CHANNEL_ID, false],
      ]),
    );

    const signing = await loadSigningChannelIds([CHANNEL_ID, OTHER_CHANNEL_ID]);

    expect(signing.has(CHANNEL_ID)).toBe(true);
    expect(signing.has(OTHER_CHANNEL_ID)).toBe(false);
    expect(loadChannelSignPostsByIds).toHaveBeenCalledTimes(1);
  });
});

describe('disclosesWriters', () => {
  const signing: ReadonlySet<string> = new Set([CHANNEL_ID]);

  it('discloses a channel account that signs', () => {
    expect(disclosesWriters(CHANNEL_ID, { kind: 'channel' }, signing)).toBe(true);
  });

  /**
   * The `kind` clause on its own. A settings row saying `signPosts: true` under a
   * PERSONAL account is not a channel disclosing its writer — it is a row that
   * should not exist — and reading it as consent would name somebody on a person's
   * own post.
   */
  it.each([['personal'], ['organization'], ['project'], ['bot']] as const)(
    'refuses a signing account of kind %s',
    (kind) => {
      expect(disclosesWriters(CHANNEL_ID, { kind }, signing)).toBe(false);
    },
  );

  it('refuses an account whose kind is unknown', () => {
    expect(disclosesWriters(CHANNEL_ID, {}, signing)).toBe(false);
  });

  /**
   * An account Oxy could not resolve. The identity path answers `undefined` here,
   * and an unresolved account must never be treated as a channel — the whole
   * disclosure rests on knowing what kind of account this is.
   */
  it('refuses an unresolvable account', () => {
    expect(disclosesWriters(CHANNEL_ID, undefined, signing)).toBe(false);
  });

  it('refuses a channel that does not sign', () => {
    expect(disclosesWriters(OTHER_CHANNEL_ID, { kind: 'channel' }, signing)).toBe(false);
  });

  it('refuses an empty id even against a set that somehow contains one', () => {
    expect(disclosesWriters('', { kind: 'channel' }, new Set(['']))).toBe(false);
  });
});

/**
 * ONE reader of the flag, enforced by scanning the tree.
 *
 * `PostHydrationService` used to run this query itself. When the writers list
 * needed the same answer, the tempting move was to write a second `UserSettings`
 * read beside it — which is how the byline and the list would end up disagreeing
 * about a consent decision, silently, in whichever direction the drift happened
 * to go. This scan is what makes that a test failure instead.
 *
 * The allow-list is deliberately short and each entry is a DIFFERENT job:
 * declaring the field, writing it, and reading it. Anything else that starts
 * mentioning `signPosts` in code has to justify itself here first.
 */
describe('signPosts has exactly one reader', () => {
  const BACKEND_SRC = path.resolve(__dirname, '../..');

  /**
   * Files that may mention the flag in CODE. Comments are stripped before the
   * scan, so a docstring explaining the rule (there are several, including in
   * `PostHydrationService`) does not count as reading it.
   */
  const ALLOWED = new Set([
    // The declaration: the assembled record's field.
    'db/userProfile/userSettingsRecord.ts',
    // The STORE: the dotted-path→column map (the write) and the narrow batched
    // read the decision below is built on. Both are the one path to the table.
    'db/userProfile/userSettingsRepository.ts',
    // The write: `PUT /profile/settings/:userId`, the operator's toggle.
    'routes/profileSettings.ts',
    // The read: the one authority this file is about.
    'services/channelWriterDisclosure.ts',
  ]);

  /** Strip block and line comments so a docstring is not read as a usage. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
        collect(full, out);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  it('mentions the flag in code only where it is declared, written and read', () => {
    const files = collect(BACKEND_SRC);
    // Vacuity floor: a broken walk must not read as a clean result.
    expect(files.length).toBeGreaterThan(200);

    const mentions = files
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('signPosts'))
      .map((file) => path.relative(BACKEND_SRC, file))
      .sort();

    // Vacuity floor for the comment stripper: every allowed file really was found,
    // so a stripper that ate the whole source could not pass this.
    expect(mentions).toEqual([...ALLOWED].sort());
  });

  it('does not let PostHydrationService read the flag for itself', () => {
    const source = readFileSync(path.join(BACKEND_SRC, 'services/PostHydrationService.ts'), 'utf8');
    // Vacuity floor: the file really was read.
    expect(source.length).toBeGreaterThan(1000);

    expect(source).toContain("from './channelWriterDisclosure'");
    expect(stripComments(source)).not.toContain('signPosts');
  });
});
