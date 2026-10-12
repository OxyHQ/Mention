import { memo } from 'react';
import { View } from 'react-native';
import { Sticker } from '@oxy.so/bloom/sticker';
import { useSticker } from '@oxy.so/stickers/react';

import { EMPTY_STATE_STICKERS, type EmptyStateStickerName } from '@/lib/stickers';

/** The sticker's square edge above an empty state. */
const SIZE = 120;

/**
 * The picture above an empty state: a sticker from Oxy's catalogue, animated
 * where the platform can (Bloom's `Sticker` shows its still under reduced
 * motion, or while the animation loads).
 *
 * Decorative: `EmptyState` already announces the title and subtitle as one
 * accessibility element. Until the sticker resolves the slot keeps its size
 * and stays empty rather than shifting the text when it arrives; if Oxy cannot
 * be reached it simply stays empty, which is still a complete empty state.
 */
export const EmptyStateSticker = memo(function EmptyStateSticker({
  name,
}: {
  name: EmptyStateStickerName;
}) {
  const { data: sticker } = useSticker(EMPTY_STATE_STICKERS[name]);
  if (!sticker) return <View style={{ width: SIZE, height: SIZE }} />;
  return (
    <Sticker
      animation={sticker.animation.url}
      fallback={sticker.fallback.url}
      size={SIZE}
      decorative
    />
  );
});
