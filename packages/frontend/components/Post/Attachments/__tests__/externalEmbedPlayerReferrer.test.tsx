import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { WEB_BASE_URL } from '@/config';

/**
 * YouTube refuses an embed whose request carries no `Referer`, answering error
 * 153 — `ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER`. Reproduced directly
 * against `youtube-nocookie.com`: the same embed URL fetched without a referrer
 * returns that error code, and returns none when `https://mention.earth/` is
 * sent.
 *
 * A native WebView handed a bare `{ uri }` sends no referrer at all, so every
 * YouTube embed in the feed failed on device. This pins the header onto the
 * source so removing it fails here rather than in the app.
 */

const capturedProps: Array<Record<string, unknown>> = [];

jest.mock('react-native-webview', () => ({
  WebView: (props: Record<string, unknown>) => {
    capturedProps.push(props);
    return null;
  },
}));

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    measure: () => null,
    runOnJS: (fn: unknown) => fn,
    useAnimatedRef: () => ({ current: null }),
    useFrameCallback: () => ({ setActive: () => undefined }),
  };
});

jest.mock('expo-router', () => ({ useFocusEffect: () => undefined }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../ExternalEmbedPoster', () => ({ ExternalEmbedPoster: () => null }));

import { ExternalEmbedPlayer } from '../ExternalEmbedPlayer';

const YOUTUBE_PARAMS = {
  type: 'youtube_video' as const,
  source: 'youtube' as const,
  playerUri: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=0&autoplay=1',
};

function renderPlayer(params: typeof YOUTUBE_PARAMS) {
  capturedProps.length = 0;
  act(() => {
    TestRenderer.create(
      <ExternalEmbedPlayer
        params={params}
        width={400}
        active
        onPressPlay={() => undefined}
        onDeactivate={() => undefined}
      />,
    );
  });
  return capturedProps[0];
}

describe('native embed player identifies its embedder', () => {
  it('sends a Referer with the YouTube embed request', () => {
    const props = renderPlayer(YOUTUBE_PARAMS);
    const source = props?.source as { uri: string; headers?: Record<string, string> };

    expect(source.uri).toBe(YOUTUBE_PARAMS.playerUri);
    expect(source.headers?.Referer).toBe(`${WEB_BASE_URL}/`);
  });

  it('sends it for every provider, not only YouTube', () => {
    // The referrer requirement is not YouTube-specific, and the player is one
    // component: a provider-conditional header would be a second code path that
    // only the conditioned provider ever exercises.
    const props = renderPlayer({
      ...YOUTUBE_PARAMS,
      type: 'spotify_song' as never,
      source: 'spotify' as never,
      playerUri: 'https://open.spotify.com/embed/track/abc',
    });
    const source = props?.source as { uri: string; headers?: Record<string, string> };

    expect(source.headers?.Referer).toBe(`${WEB_BASE_URL}/`);
  });
});
