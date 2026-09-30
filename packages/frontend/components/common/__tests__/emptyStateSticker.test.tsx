/**
 * An empty state's picture is a catalogue sticker (here the feed's sad bear): resolved by id
 * through `@oxy.so/stickers`, drawn by Bloom's `Sticker` (stubbed in
 * `test-support/bloomSticker.js`, which keeps the props on the node), and a
 * fixed-size blank until it resolves so the copy below it does not jump.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StickersProvider } from '@oxy.so/stickers/react';
import type { StickersClient } from '@oxy.so/stickers';

import { EmptyStateSticker } from '../EmptyStateSticker';
import { EMPTY_STATE_STICKERS } from '@/lib/stickers';

const FEED_EMPTY_STICKER_ID = EMPTY_STATE_STICKERS.feedFollowing;

const SAD_BEAR = {
    id: FEED_EMPTY_STICKER_ID,
    packId: 'pack',
    emoji: ['😢'],
    keywords: ['sad'],
    size: 512,
    durationMs: 3000,
    animation: { url: 'https://cloud.oxy.so/content/sad.json', sha256: 'a'.repeat(64), mime: 'application/json', bytes: 1 },
    fallback: { url: 'https://cloud.oxy.so/content/sad.webp', sha256: 'b'.repeat(64), mime: 'image/webp', bytes: 1 },
};

async function renderWith(getSticker: StickersClient['getSticker']): Promise<TestRenderer.ReactTestRenderer> {
    const client = { getSticker } as unknown as StickersClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(
            <QueryClientProvider client={queryClient}>
                <StickersProvider client={client}>
                    <EmptyStateSticker name="feedFollowing" />
                </StickersProvider>
            </QueryClientProvider>,
        );
    });
    // Let the query settle.
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return renderer;
}

function stickers(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'bloom-sticker');
}

it('draws the sad bear from the catalogue, animated over its still, as decoration', async () => {
    const getSticker = jest.fn(async () => SAD_BEAR);
    const renderer = await renderWith(getSticker);
    expect(getSticker).toHaveBeenCalledWith(FEED_EMPTY_STICKER_ID);
    const [sticker] = stickers(renderer);
    expect(sticker.props).toMatchObject({
        animation: SAD_BEAR.animation.url,
        fallback: SAD_BEAR.fallback.url,
        size: 120,
        decorative: true,
    });
});

it('keeps an empty slot of the same size when the sticker cannot be resolved', async () => {
    const getSticker = jest.fn(async () => null);
    const renderer = await renderWith(getSticker);
    expect(getSticker).toHaveBeenCalled();
    expect(stickers(renderer)).toHaveLength(0);
});
