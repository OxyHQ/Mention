import type { HydratedPost } from '@mention/shared-types';
import { buildReplyTree, type ReplyNode } from '../feedUtils';

// Fixture convention of this directory (see feedPageMerge.test.ts): the tree only
// reads `id` and `parentPostId`, so a full DTO would be noise.
function reply(id: string, parentPostId?: string): HydratedPost {
    return { id, parentPostId } as unknown as HydratedPost;
}

function shape(nodes: ReplyNode[]): Record<string, unknown>[] {
    return nodes.map((node) => ({ id: node.reply.id, children: shape(node.children) }));
}

describe('buildReplyTree', () => {
    it('nests a reply under the reply it answers, and direct answers under the root', () => {
        const tree = buildReplyTree(
            [reply('a', 'root'), reply('b', 'a'), reply('c', 'b'), reply('d', 'root')],
            'root',
        );

        expect(shape(tree)).toEqual([
            {
                id: 'a',
                children: [{ id: 'b', children: [{ id: 'c', children: [] }] }],
            },
            { id: 'd', children: [] },
        ]);
    });

    it('promotes a reply whose parent is not in this batch to the top level', () => {
        // Paging can deliver a reply before its parent; it must still render.
        const tree = buildReplyTree([reply('orphan', 'not-loaded')], 'root');

        expect(shape(tree)).toEqual([{ id: 'orphan', children: [] }]);
    });

    it('keeps the thread root itself at the top level even when it is in the batch', () => {
        const tree = buildReplyTree([reply('root', 'root'), reply('a', 'root')], 'root');

        expect(shape(tree)).toEqual([
            { id: 'root', children: [] },
            { id: 'a', children: [] },
        ]);
    });

    it('treats a reply with no parent at all as top level', () => {
        const tree = buildReplyTree([reply('a')], 'root');

        expect(shape(tree)).toEqual([{ id: 'a', children: [] }]);
    });

    it('returns nothing for an empty batch', () => {
        expect(buildReplyTree([], 'root')).toEqual([]);
    });
});
