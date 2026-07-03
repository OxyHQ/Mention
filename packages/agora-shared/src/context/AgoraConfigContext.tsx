import React, { createContext, useContext, useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import type { AgoraTheme, UserEntity, HttpClient } from '../types';
import { createAgoraService, type AgoraServiceInstance } from '../services/spacesService';
import { RoomSocketService } from '../services/spaceSocketService';
import { createGetRoomToken, type GetRoomTokenFn } from '../services/livekitService';

/**
 * The viewer's pinned Syra podcast (resolved from their profile media), surfaced
 * by {@link AgoraConfig.getPinnedPodcast}. `title`/`artworkUrl` are optional —
 * the id is all the picker needs to drill into the episode list.
 */
export interface PinnedPodcast {
  syraPodcastId: string;
  title?: string;
  artworkUrl?: string;
}

export interface AgoraConfig {
  httpClient: HttpClient;
  socketUrl: string;
  useTheme: () => AgoraTheme;
  /**
   * Translate a UI string key to the active locale. Optional: hosts WITH an i18n
   * layer (the Mention frontend) inject their real translator so the shared
   * live-room UI localizes; hosts WITHOUT one (the standalone Agora app) omit it
   * and the shared components fall back to their bundled English source copy.
   * Keys are looked up flat (e.g. `agora.podcastStream.disclaimer`).
   */
  t?: (key: string, options?: Record<string, string | number>) => string;
  /**
   * Resolve the viewer's pinned Syra podcast from their profile media, or `null`
   * when they have none / it can't be read. Optional: hosts that expose profile
   * media wire it so the podcast picker can offer a one-tap "stream my pinned
   * podcast" quick-start row. The picker renders nothing when this is absent or
   * resolves to `null`.
   */
  getPinnedPodcast?: () => Promise<PinnedPodcast | null>;
  useUserById: (id: string | undefined) => UserEntity | undefined;
  ensureUserById: (
    id: string,
    loader: (id: string) => Promise<UserEntity | null | undefined>
  ) => Promise<UserEntity | undefined>;
  getCachedFileDownloadUrl: (oxyServices: unknown, fileId: string, variant?: string) => Promise<string>;
  getCachedFileDownloadUrlSync: (oxyServices: unknown, fileId: string, variant?: string) => string;
  AvatarComponent: React.ComponentType<{ size: number; source?: string; shape?: string; style?: ViewStyle }>;
  toast: {
    (message: string, options?: Record<string, unknown>): void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
  introSound?: number;
  isDesktop?: boolean;
  useIsDesktop?: () => boolean;
  onRoomChanged?: (roomId: string) => void;
  /**
   * Optional NativeWind className applied to the floating live-room dock and its
   * backdrop. Hosts whose web shell uses a DOCUMENT-scroll model (html/body/#root
   * = height:auto + overflow:visible, the window is the scroller) must pass
   * `"web:fixed"` so the dock pins to the VIEWPORT bottom instead of resolving
   * its `position: absolute` against the tall document and sinking to the page
   * bottom. Omitted on hosts with the default fixed-viewport web model (and on
   * native, where `web:fixed` is a no-op and the dock pins via `position:
   * absolute` against the screen-filling root).
   */
  dockClassName?: string;
}

export interface AgoraConfigInternal extends AgoraConfig {
  agoraService: AgoraServiceInstance;
  roomSocketService: RoomSocketService;
  getRoomToken: GetRoomTokenFn;
}

const AgoraConfigContext = createContext<AgoraConfigInternal | null>(null);

export function useAgoraConfig(): AgoraConfigInternal {
  const config = useContext(AgoraConfigContext);
  if (!config) throw new Error('useAgoraConfig must be used within an AgoraProvider');
  return config;
}

export function AgoraProvider({ config, children }: { config: AgoraConfig; children: React.ReactNode }) {
  const fullConfig = useMemo<AgoraConfigInternal>(() => {
    const agoraService = createAgoraService(config.httpClient);
    const roomSocketService = new RoomSocketService(config.socketUrl);
    const getRoomToken = createGetRoomToken(config.httpClient);
    return { ...config, agoraService, roomSocketService, getRoomToken };
  }, [config]);

  return (
    <AgoraConfigContext.Provider value={fullConfig}>
      {children}
    </AgoraConfigContext.Provider>
  );
}
