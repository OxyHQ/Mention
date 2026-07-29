/**
 * Flow 4 — the search screen's submit.
 *
 * Assertion supplied by the agent that built the surface; the reason is theirs,
 * the reachability is verified here. It runs signed-out: the tabs the screen
 * actually queries on submit (starter packs, hashtags, feeds) are public
 * endpoints, and only the posts/users/lists tabs need a session.
 *
 * The companion assertions — that the suggestion rows survive typing and survive
 * blur — are NOT here, and deliberately so. The screen serves two row sets (idle:
 * recents, trending, the operator cheat-sheet; typing: commit-this-query, an
 * optional go-to-profile, an optional operator completion, then filtered
 * recents), and the swap between them does not track the typed text closely
 * enough for either set to be a stable landmark at assertion time: the
 * cheat-sheet row flaked roughly one run in three, and the commit-this-query row
 * was never present at all within a 30s wait while typing. Shipping either would
 * have put a coin-flip in front of a production promotion. What is needed is a
 * landmark the screen guarantees while a query is being typed; that is a
 * question for the surface's author, not something to guess at here.
 */

import { expect, test } from '../fixtures';

/**
 * Several characters on purpose. A one-character query passes whether or not
 * the stale-closure bug is present, because there is no "minus its last
 * character" to observe.
 */
const QUERY = 'starter';

test('submitting carries the full typed query', async ({ page, candidate }) => {
  await page.goto('/search');

  const input = page.getByPlaceholder('Search Mention').first();
  await expect(input).toBeVisible();

  // The outgoing request is the unambiguous signal — rendered results can lag,
  // dedupe or fall back, and would let a truncated query look fine.
  const submittedTerms: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'https://api.mention.earth') return;
    const term = url.searchParams.get('search') ?? url.searchParams.get('query');
    if (term !== null) submittedTerms.push(term);
  });

  await input.click();
  // No per-character delay, and Enter on the final character: the keystroke and
  // the submit can then land in one batch, which is the interleave the
  // stale-closure fix defends against and the one jest can model but not
  // reproduce.
  await page.keyboard.type(QUERY, { delay: 0 });
  await page.keyboard.press('Enter');

  await expect
    .poll(() => submittedTerms.length, {
      message: 'submitting the query must reach the API',
    })
    .toBeGreaterThan(0);

  // The last term the screen asked for is the one the submit produced. With the
  // stale closure it is `QUERY` minus its final character.
  await expect
    .poll(() => submittedTerms.at(-1), {
      message: 'the submitted query must be the complete typed string',
    })
    .toBe(QUERY);

  expect(candidate.scriptErrors).toEqual([]);
});
