import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { getPlayerAspect, type EmbedPlayerParams } from '@/utils/embedPlayer';
import { ExternalEmbedPoster } from './ExternalEmbedPoster';

export interface ExternalEmbedPlayerProps {
  params: EmbedPlayerParams;
  /** Link-preview thumbnail shown before the player is mounted. */
  thumb?: string;
  /** Available render width — used for aspect-ratio resolution. */
  width: number;
  /** Whether the iframe should be mounted (set by the wrapper on play). */
  active: boolean;
  /** Fired when the play button is pressed (the wrapper gates consent). */
  onPressPlay: () => void;
  /**
   * Web has no viewport-exit pause (no reanimated frame loop); declared only for
   * prop parity with the native player.
   */
  onDeactivate: () => void;
}

/**
 * Web external embed player. The `<iframe>` is mounted ONLY while `active`, so
 * nothing external loads before the user presses play (and consent is granted).
 */
export function ExternalEmbedPlayer({ params, thumb, width, active, onPressPlay }: ExternalEmbedPlayerProps) {
  const [loading, setLoading] = useState(true);

  const aspect = useMemo(
    () => getPlayerAspect({ type: params.type, width, hasThumb: !!thumb }),
    [params.type, width, thumb],
  );

  return (
    <View style={[{ width: '100%' }, aspect, { overflow: 'hidden' }]}>
      {active ? (
        <iframe
          src={params.playerUri}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          onLoad={() => setLoading(false)}
          style={{ border: 0, width: '100%', height: '100%', backgroundColor: 'transparent' }}
        />
      ) : null}
      <ExternalEmbedPoster thumb={thumb} active={active} loading={loading} onPressPlay={onPressPlay} />
    </View>
  );
}
