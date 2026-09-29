import { memo } from 'react';
import { View } from 'react-native';
import { Sticker } from '@oxy.so/bloom/sticker';
import { useSticker } from '@oxy.so/stickers/react';

import { FEED_EMPTY_STICKER_ID } from '@/lib/stickers';

/** The sticker's square edge in an empty feed. */
const SIZE = 120;

/**
 * The picture above an empty feed: a sticker from Oxy's catalogue, animated
 * where the platform can (Bloom's `Sticker` shows its still under reduced
 * motion, or while the animation loads).
 *
 * Decorative: `EmptyState` already announces the title and subtitle as one
 * accessibility element. Until the sticker resolves the slot keeps its size
 * and stays empty rather than shifting the text when it arrives; if Oxy cannot
 * be reached it simply stays empty, which is still a complete empty state.
 */
export const FeedEmptySticker = memo(function FeedEmptySticker() {
    const { data: sticker } = useSticker(FEED_EMPTY_STICKER_ID);
    if (!sticker) return <SizedSlot />;
    return (
        <Sticker
            animation={sticker.animation.url}
            fallback={sticker.fallback.url}
            size={SIZE}
            decorative
        />
    );
});

function SizedSlot() {
    return <View style={{ width: SIZE, height: SIZE }} />;
}
