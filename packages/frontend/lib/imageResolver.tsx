import React, { createContext, useContext, type ReactNode } from 'react';

export type ImageResolver = (id: string) => string | undefined;

const ImageResolverContext = createContext<ImageResolver | null>(null);
ImageResolverContext.displayName = 'BloomImageResolverContext';

interface ImageResolverProviderProps {
  value: ImageResolver;
  children: ReactNode;
}

export function ImageResolverProvider({ value, children }: ImageResolverProviderProps): React.JSX.Element {
  return <ImageResolverContext.Provider value={value}>{children}</ImageResolverContext.Provider>;
}

export function useImageResolver(): ImageResolver | null {
  return useContext(ImageResolverContext);
}
