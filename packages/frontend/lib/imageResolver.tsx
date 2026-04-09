import React, { createContext, useContext } from 'react';

export type ImageResolver = (id: string) => string | undefined;

const ImageResolverContext = createContext<ImageResolver | null>(null);
ImageResolverContext.displayName = 'BloomImageResolverContext';

export const ImageResolverProvider = ImageResolverContext.Provider;

export function useImageResolver(): ImageResolver | null {
  return useContext(ImageResolverContext);
}
