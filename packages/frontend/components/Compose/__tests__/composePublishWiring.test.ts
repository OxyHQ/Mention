import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How `handlePost` sequences a publish, read from source.
 *
 * `ComposeScreen` is a 3,700-line screen over a dozen providers, so — like
 * `composeFooterLayout.test.ts` — this reads its source. The behaviour of each
 * piece is pinned where it lives (`hooks/__tests__/useDraftManagerPublish.test.tsx`,
 * `useComposeExit.test.tsx`, `components/navigation/__tests__/tabHistory.test.ts`);
 * what is pinned here is that the screen calls them, in an order that cannot
 * leave a published post behind as a draft (OxyHQ/Mention#1140).
 */
const screen = readFileSync(join(__dirname, '..', 'ComposeScreen.tsx'), 'utf8');

function handlePostBody(): string {
  const start = screen.indexOf('const handlePost = async () => {');
  const end = screen.indexOf('\n  };\n', start);
  if (start < 0 || end < start) throw new Error('No handlePost in ComposeScreen');
  return screen.slice(start, end);
}

/** The publish's OWN catch — the last one; earlier ones guard the channel repost. */
function outerCatch(body: string): number {
  const at = body.lastIndexOf('} catch (error) {');
  if (at < 0) throw new Error('handlePost has no catch');
  return at;
}

function successPath(body: string): string {
  return body.slice(0, outerCatch(body));
}

function failurePath(body: string): string {
  return body.slice(outerCatch(body), body.lastIndexOf('} finally {'));
}

describe('handlePost', () => {
  const body = handlePostBody();

  it('stops autosave before the request, so a debounce cannot re-save the post', () => {
    const begin = body.indexOf('beginPublish();');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(body.indexOf('await createPost('));
    expect(begin).toBeLessThan(body.indexOf('await createReply('));
    expect(begin).toBeLessThan(body.indexOf('await createThread('));
    expect(begin).toBeLessThan(body.indexOf('feedService.editPost('));
  });

  it('deletes the draft through the manager, never through the id its render captured', () => {
    // `currentDraftId` in this closure is from the render that started the
    // publish; an autosave during the request creates a draft it never sees.
    const success = successPath(body);
    expect(success).toContain('await publishSucceeded();');
    expect(success).not.toMatch(/deleteDraft\(\s*currentDraftId/);
  });

  it('empties the composer and then takes it out of reach', () => {
    const success = successPath(body);
    const reset = success.indexOf('resetComposerAfterPublish();');
    const leave = success.indexOf('leaveAfterPublish();');
    expect(reset).toBeGreaterThan(success.indexOf('await publishSucceeded();'));
    expect(leave).toBeGreaterThan(reset);
    // `dismiss` is the ✕'s exit, which keeps the composer reachable on purpose.
    expect(success).not.toMatch(/\bdismiss\(\)/);
  });

  it('keeps and saves the draft when the publish fails', () => {
    const failure = failurePath(body);
    expect(failure).toContain('publishFailed(draftRefs())');
    expect(failure).not.toContain('resetComposerAfterPublish');
    expect(failure).not.toContain('leaveAfterPublish');
  });

  it('resets every piece of content that "Clear all" does', () => {
    const reset = screen.slice(
      screen.indexOf('const resetComposerAfterPublish = () => {'),
      screen.indexOf('const handlePost = async () => {'),
    );
    expect(reset).toContain('clearComposerContent();');
    expect(reset).toContain('clearQuote();');
    const clearAll = screen.slice(screen.indexOf('control={clearAllControl}'));
    expect(clearAll.slice(0, clearAll.indexOf('toast('))).toContain('clearComposerContent();');
  });
});
