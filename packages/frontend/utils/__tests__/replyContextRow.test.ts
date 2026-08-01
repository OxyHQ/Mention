import type { HydratedPost, PostUser } from '@mention/shared-types';
import { resolveReplyContextRow } from '../replyContextRow';

/**
 * Oxy owns handle normalization and tests it upstream; the `@oxyhq/core` barrel
 * also drags in a crypto polyfill jest cannot load. Stub the one function at the
 * boundary — same shape as the real contract: the normalized handle, or `null`
 * when the user has no usable one. (Babel hoists `jest.mock` above the imports,
 * so declaring it here still applies to the import above.)
 */
jest.mock('@oxyhq/core', () => ({
    getNormalizedUserHandle: (user?: { username?: string }) =>
        user?.username && user.username.length > 0 ? user.username : null,
}));

/**
 * The row is decided from the POST, not from how the row got here.
 *
 * Before this, "Replying to @…" was derived from `FeedSliceReason.replyContext`
 * and passed into the renderer as props. Only the feed-slice renderer set them,
 * and only for the feeds whose server definition opts into reply slicing — so
 * the same reply showed context on Following and none at all on trending, on
 * search, on saved posts, on the anonymous For You page (which the server
 * returns with `slices: []`), or anywhere else a post is rendered directly.
 *
 * Jest cannot prove the row LOOKS right — that is browser work. It can prove the
 * decision, which is the part that was wrong on most surfaces.
 */

const PARENT_AUTHOR: PostUser = {
  id: 'oxy-parent',
  username: 'parenthandle',
  name: { displayName: 'Parent Author' },
  avatar: null,
};

function post(replyContext?: HydratedPost['replyContext']): HydratedPost {
  // Only `replyContext` is read; a full DTO would be noise.
  return { id: 'p1', replyContext } as unknown as HydratedPost;
}

const PLAIN = { isNested: false };

describe('resolveReplyContextRow', () => {
    it('renders nothing for a post that is not a reply', () => {
        expect(resolveReplyContextRow({ post: post(undefined), ...PLAIN })).toBeNull();
    });

    it('names the parent author when the server resolved one', () => {
        const row = resolveReplyContextRow({
            post: post({ parentAuthor: PARENT_AUTHOR }),
            ...PLAIN,
        });

        expect(row).toEqual({ authorHandle: 'parenthandle', label: 'parenthandle' });
    });

    it('still renders a row when the parent could not be named', () => {
        // An unlinked federated reply: marked as a reply, with nobody to name.
        // Rendering nothing here is exactly what made "@someone thank you!" read
        // as an ordinary top-level post.
        const row = resolveReplyContextRow({ post: post({}), ...PLAIN });

        expect(row).not.toBeNull();
        expect(row?.label).toBeUndefined();
        expect(row?.authorHandle).toBeUndefined();
    });

    it('never offers a display name as a hover-card handle', () => {
        // A parent author with no usable handle: the LABEL may fall back to the
        // display name so the row still reads as a reply to someone, but
        // `authorHandle` must stay empty — the hover card fetches it as a handle.
        const row = resolveReplyContextRow({
            post: post({
                parentAuthor: { id: 'oxy-ghost', username: '', name: { displayName: 'Ghost' }, avatar: null },
            }),
            ...PLAIN,
        });

        expect(row?.label).toBe('Ghost');
        expect(row?.authorHandle).toBeUndefined();
    });

    it('still names the parent when it is prepended directly above', () => {
        // A feed `replyContext` slice renders [parent, reply]. The header is NOT
        // suppressed there: it names a DIFFERENT author, which is the informative
        // case and the whole substance of the bug. Redundant context is cheap;
        // missing context is what was broken.
        const row = resolveReplyContextRow({
            post: post({ parentAuthor: PARENT_AUTHOR }),
            isNested: false,
        });

        expect(row).toEqual({ authorHandle: 'parenthandle', label: 'parenthandle' });
    });

    it('renders nothing for a self-thread continuation', () => {
        // The SERVER omits `replyContext` for a reply to its own author's post,
        // so a continuation reaches the renderer with nothing to show. This
        // asserts the client honours that rather than inventing a header — see
        // postHydrationReplyContext.test.ts for the server half.
        expect(resolveReplyContextRow({ post: post(undefined), ...PLAIN })).toBeNull();
    });

    it('stays silent inside a quote card', () => {
        const row = resolveReplyContextRow({
            post: post({ parentAuthor: PARENT_AUTHOR }),
            isNested: true,
        });

        expect(row).toBeNull();
    });

    it('tolerates a missing post', () => {
        expect(resolveReplyContextRow({ post: undefined, ...PLAIN })).toBeNull();
    });
});
