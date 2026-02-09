import React, { createContext, useContext, useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import type { AgoraTheme, UserEntity, HttpClient } from '../types';
import { createAgoraService, type AgoraServiceInstance } from '../services/spacesService';
import { RoomSocketService } from '../services/spaceSocketService';
import { createGetRoomToken, type GetRoomTokenFn } from '../services/livekitService';

export interface AgoraConfig {
  httpClient: HttpClient;
  socketUrl: string;
  useTheme: () => AgoraTheme;
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
