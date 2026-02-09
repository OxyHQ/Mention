import React, { createContext, useContext, useMemo } from 'react';
import type { SpacesTheme, UserEntity } from '../types';
import { createSpacesService, type SpacesServiceInstance } from '../services/spacesService';
import { SpaceSocketService } from '../services/spaceSocketService';
import { createGetSpaceToken, type GetSpaceTokenFn } from '../services/livekitService';

export interface SpacesConfig {
  httpClient: {
    get: (url: string, config?: any) => Promise<any>;
    post: (url: string, data?: any, config?: any) => Promise<any>;
    patch: (url: string, data?: any, config?: any) => Promise<any>;
    delete: (url: string, config?: any) => Promise<any>;
  };
  socketUrl: string;
  useTheme: () => SpacesTheme;
  useUserById: (id: string | undefined) => UserEntity | undefined;
  ensureUserById: (
    id: string,
    loader: (id: string) => Promise<UserEntity | null | undefined>
  ) => Promise<UserEntity | undefined>;
  getCachedFileDownloadUrl: (oxyServices: any, fileId: string, variant?: string) => Promise<string>;
  getCachedFileDownloadUrlSync: (oxyServices: any, fileId: string, variant?: string) => string;
  AvatarComponent: React.ComponentType<{ size: number; source?: string; shape?: string; style?: any }>;
  toast: {
    (message: string, options?: any): void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
  introSound?: any;
  isDesktop?: boolean;
  useIsDesktop?: () => boolean;
}

export interface SpacesConfigInternal extends SpacesConfig {
  spacesService: SpacesServiceInstance;
  spaceSocketService: SpaceSocketService;
  getSpaceToken: GetSpaceTokenFn;
}

const SpacesConfigContext = createContext<SpacesConfigInternal | null>(null);

export function useSpacesConfig(): SpacesConfigInternal {
  const config = useContext(SpacesConfigContext);
  if (!config) throw new Error('useSpacesConfig must be used within a SpacesProvider');
  return config;
}

export function SpacesProvider({ config, children }: { config: SpacesConfig; children: React.ReactNode }) {
  const fullConfig = useMemo<SpacesConfigInternal>(() => {
    const spacesService = createSpacesService(config.httpClient);
    const spaceSocketService = new SpaceSocketService(config.socketUrl);
    const getSpaceToken = createGetSpaceToken(config.httpClient);
    return { ...config, spacesService, spaceSocketService, getSpaceToken };
  }, [config]);

  return (
    <SpacesConfigContext.Provider value={fullConfig}>
      {children}
    </SpacesConfigContext.Provider>
  );
}
