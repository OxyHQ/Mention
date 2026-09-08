import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { LinkifiedText } from '../LinkifiedText';

const mockOpenExternalLink = jest.fn();

/**
 * How many `<Text>` nodes a body of prose costs.
 *
 * Every run of plain prose used to be wrapped in its own styleless `<Text>`, so
 * the commonest post in the feed — one with a body and no entities — rendered
 * two text nodes to draw one line, and a post with N mentions rendered up to
 * N+1 extra. None of them carried a style, a press handler or an accessibility
 * role: the root `<Text>` already supplies everything a run inherits. React
 * Native composes strings and elements inside a `<Text>` identically, so the
 * wrapper was a host text node, a shadow node and (under NativeWind's global
 * class-name polyfill) a `react-native-css` interop component drawing nothing.
 *
 * Two halves, and the file needs both:
 *
 *  1. PROSE COSTS ONE NODE. Alone this is satisfiable by a component that
 *     renders the text and drops every link.
 *  2. AN ENTITY STILL GETS ITS OWN NODE, because it needs one — it is a
 *     different colour and it is pressable. Alone this is satisfiable by the
 *     wrapping this file exists to forbid.
 */

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('@oxyhq/core', () => ({
    getNormalizedUserHandle: (user: { username?: string }) => user?.username ?? null,
}));

// The hover card is a pass-through on native; keeping the real one here would
// only add the platform file's indirection to what is a shape assertion.
jest.mock('@/components/ProfileHoverCard', () => ({
    ProfileHoverCard: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/utils/openExternalLink', () => ({
    openExternalLink: (...args: unknown[]) => mockOpenExternalLink(...args),
}));

/** Every host node the render produced, as `[type, text-or-null]` pairs. */
function hostNodes(element: React.ReactElement) {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(element);
    });
    if (!renderer) throw new Error('render produced no tree');
    const out: { type: string; strings: string[] }[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== 'object') return;
        const n = node as { type: string; children: unknown[] | null };
        out.push({
            type: n.type,
            strings: (n.children ?? []).filter((c): c is string => typeof c === 'string'),
        });
        for (const child of n.children ?? []) walk(child);
    };
    walk(renderer.toJSON());
    act(() => renderer?.unmount());
    return out;
}

describe('LinkifiedText', () => {
    beforeEach(() => {
        mockOpenExternalLink.mockReset();
    });

    it('draws prose with a single text node', () => {
        const nodes = hostNodes(<LinkifiedText text="just some words about nothing" />);
        const texts = nodes.filter((n) => n.type === 'Text');

        expect(texts).toHaveLength(1);
        expect(texts[0].strings.join('')).toBe('just some words about nothing');
    });

    it('still gives a hashtag its own text node, with the prose around it inline', () => {
        // The control for the test above. The hashtag is pressable and coloured,
        // so it MUST be its own node; the two prose runs beside it must not be.
        const nodes = hostNodes(<LinkifiedText text="hey #expo look at this" />);
        const texts = nodes.filter((n) => n.type === 'Text');

        expect(texts).toHaveLength(2);
        expect(texts[0].strings).toEqual(['hey ', ' look at this']);
        expect(texts[1].strings).toEqual(['#expo']);
    });

    it.each([
        [
            'an https URL',
            'Read https://example.com/articles/a-very…',
            'Read https://example.com/articles/a-very-long-slug',
            'https://example.com/articles/a-very-long-slug',
        ],
        [
            'a scheme-less www URL',
            'Read www.example.com/articles/a-very…',
            'Read www.example.com/articles/a-very-long-slug',
            'https://www.example.com/articles/a-very-long-slug',
        ],
    ])('opens the complete source destination for %s cut in the visible text', (_label, text, linkTargetText, expected) => {
        let renderer: TestRenderer.ReactTestRenderer | undefined;
        act(() => {
            renderer = TestRenderer.create(
                <LinkifiedText text={text} linkTargetText={linkTargetText} />,
            );
        });
        if (!renderer) throw new Error('render produced no tree');

        const link = renderer.root.findAll(
            (node) => typeof node.props.onPress === 'function' &&
                typeof node.props.children === 'string' &&
                node.props.children.includes('example.com'),
        )[0];
        if (!link) throw new Error('render produced no pressable URL');

        act(() => link.props.onPress());
        expect(mockOpenExternalLink).toHaveBeenCalledWith(expected);
        act(() => renderer?.unmount());
    });
});
