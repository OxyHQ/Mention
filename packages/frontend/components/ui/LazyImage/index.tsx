/**
 * Enhanced LazyImage Component
 * Optimized image loading with progressive loading, size variants, and better caching
 */

import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { Image, ImageProps, View, StyleSheet, ViewStyle, ImageStyle, StyleProp, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { SPACING } from '@/styles/spacing';
import { flattenStyleArray } from '@/utils/theme';

export type ImageSize = 'thumb' | 'small' | 'medium' | 'large' | 'original';

export interface LazyImageProps extends Omit<ImageProps, 'source' | 'style'> {
  /** Image source URI or require() number */
  source: { uri: string } | number;
  /** Placeholder component shown while loading */
  placeholder?: React.ReactNode;
  /** Fallback component shown on error */
  fallback?: React.ReactNode;
  /** Distance from viewport to start loading (in pixels) */
  threshold?: number;
  /** Style for the container View */
  containerStyle?: ViewStyle | ViewStyle[];
  /** Style for the Image itself */
  style?: StyleProp<ImageStyle>;
  /** Image size variant for optimized loading */
  size?: ImageSize;
  /** Enable progressive loading (show low-res first) */
  progressive?: boolean;
  /** Low resolution source for progressive loading */
  lowResSource?: { uri: string } | number;
  /** Custom blur hash for placeholder */
  blurHash?: string;
  /** Aspect ratio (width/height) for better layout stability */
  aspectRatio?: number;
  /** Priority: 'high' loads immediately, 'low' waits for viewport */
  priority?: 'high' | 'low' | 'auto';
}

/**
 * Get optimized image URL with size variant
 * This is a placeholder - should be replaced with actual image service logic
 */
function getOptimizedImageUrl(uri: string, size: ImageSize): string {
  // If already processed or not a valid URL, return as-is
  if (typeof uri !== 'string' || (!uri.startsWith('http://') && !uri.startsWith('https://'))) {
    return uri;
  }
  
  // TODO: Implement actual image optimization service
  // This would typically add size parameters to the URL or use a CDN
  // For now, return the original URI
  return uri;
}

/**
 * Enhanced LazyImage component with progressive loading and optimization
 */
const LazyImageComponent: React.FC<LazyImageProps> = ({
  source,
  placeholder,
  fallback,
  threshold = 200,
  containerStyle,
  style,
  size = 'medium',
  progressive = false,
  lowResSource,
  blurHash,
  aspectRatio,
  priority = 'auto',
  ...imageProps
}) => {
  const theme = useTheme();
  const [shouldLoad, setShouldLoad] = useState(priority === 'high');
  const [shouldLoadHighRes, setShouldLoadHighRes] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const viewRef = useRef<View>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Determine effective source
  const effectiveSource = useMemo(() => {
    if (typeof source === 'number') {
      return source;
    }
    
    if (source.uri) {
      const uri = getOptimizedImageUrl(source.uri, size);
      return { uri };
    }
    
    return source;
  }, [source, size]);

  // Determine low-res source for progressive loading
  const effectiveLowResSource = useMemo(() => {
    if (lowResSource) {
      return typeof lowResSource === 'number' 
        ? lowResSource 
        : { uri: getOptimizedImageUrl(lowResSource.uri, 'thumb') };
    }
    if (progressive && typeof effectiveSource !== 'number' && effectiveSource.uri) {
      return { uri: getOptimizedImageUrl(effectiveSource.uri, 'thumb') };
    }
    return null;
  }, [lowResSource, progressive, effectiveSource]);

  // Setup intersection observer
  useEffect(() => {
    if (shouldLoad || typeof effectiveSource === 'number' || priority === 'high') {
      return;
    }

    if (typeof effectiveSource !== 'object' || !effectiveSource.uri) {
      return;
    }

    // Web: Use IntersectionObserver
    if (Platform.OS === 'web' && typeof window !== 'undefined' && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              setShouldLoad(true);
              if (progressive) {
                // Load high-res after low-res is shown
                setTimeout(() => setShouldLoadHighRes(true), 100);
              }
              observer.disconnect();
            }
          });
        },
        {
          rootMargin: `${threshold}px`,
        }
      );

      observerRef.current = observer;

      // Try to find DOM element
      const element = (viewRef.current as any)?._nativeNode ||
        (viewRef.current as any)?.getNode?.() ||
        (viewRef.current as any);

      if (element && element.nodeType !== undefined) {
        observer.observe(element);
      } else {
        // Fallback: load after short delay
        setTimeout(() => setShouldLoad(true), 50);
      }
    } else {
      // Native: Load immediately (native platforms handle this efficiently)
      // Or use a small delay for better performance
      const timer = setTimeout(() => {
        setShouldLoad(true);
        if (progressive) {
          setTimeout(() => setShouldLoadHighRes(true), 100);
        }
      }, 50);

      return () => clearTimeout(timer);
    }

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [effectiveSource, threshold, priority, progressive, shouldLoad]);

  // Progressive loading: start with low-res, then high-res
  useEffect(() => {
    if (progressive && shouldLoad && !shouldLoadHighRes && effectiveLowResSource) {
      // Low-res should already be loading
      // Switch to high-res after a delay
      const timer = setTimeout(() => {
        setShouldLoadHighRes(true);
      }, 300); // Show low-res for at least 300ms

      return () => clearTimeout(timer);
    }
  }, [progressive, shouldLoad, shouldLoadHighRes, effectiveLowResSource]);

  // Handle image load success
  const handleLoad = useCallback(() => {
    setIsLoading(false);
    if (imageProps.onLoad) {
      imageProps.onLoad({} as any);
    }
  }, [imageProps]);

  // Handle image load errors
  const handleError = useCallback(() => {
    setHasError(true);
    setIsLoading(false);
    if (imageProps.onError) {
      imageProps.onError({} as any);
    }
  }, [imageProps]);

  // Default placeholder
  const defaultPlaceholder = useMemo(() => (
    <View 
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: theme.colors.backgroundSecondary,
          justifyContent: 'center',
          alignItems: 'center',
        },
      ]} 
    />
  ), [theme.colors.backgroundSecondary]);

  // Container style with aspect ratio
  const finalContainerStyle = useMemo(() => {
    const styles = flattenStyleArray([containerStyle]);
    if (aspectRatio) {
      return {
        ...styles,
        aspectRatio,
        overflow: 'hidden' as const,
      };
    }
    return styles;
  }, [containerStyle, aspectRatio]);

  // Show error fallback
  if (hasError && fallback) {
    return <View style={finalContainerStyle}>{fallback}</View>;
  }

  // Show placeholder while loading
  if (!shouldLoad) {
    return (
      <View ref={viewRef} style={finalContainerStyle}>
        {placeholder || defaultPlaceholder}
      </View>
    );
  }

  // Progressive loading: show low-res first, then high-res
  if (progressive && effectiveLowResSource && !shouldLoadHighRes) {
    return (
      <View ref={viewRef} style={finalContainerStyle}>
        <Image
          {...imageProps}
          source={effectiveLowResSource}
          onLoad={handleLoad}
          onError={handleError}
          style={flattenStyleArray([StyleSheet.absoluteFill, style])}
          resizeMode={imageProps.resizeMode || 'cover'}
          blurRadius={Platform.OS === 'ios' ? 2 : 0}
        />
        {isLoading && (placeholder || defaultPlaceholder)}
      </View>
    );
  }

  // Load final image
  return (
    <View ref={viewRef} style={finalContainerStyle}>
      {progressive && effectiveLowResSource && shouldLoadHighRes && (
        <Image
          source={effectiveLowResSource}
          style={[StyleSheet.absoluteFill, { opacity: isLoading ? 1 : 0 }]}
          resizeMode={imageProps.resizeMode || 'cover'}
        />
      )}
      <Image
        {...imageProps}
        source={shouldLoad ? effectiveSource : (typeof effectiveSource === 'number' ? effectiveSource : { uri: '' })}
        onLoad={handleLoad}
        onError={handleError}
        style={flattenStyleArray([
          progressive && effectiveLowResSource && shouldLoadHighRes ? { opacity: isLoading ? 0 : 1 } : {},
          style,
        ])}
        resizeMode={imageProps.resizeMode}
      />
    </View>
  );
};

export const LazyImage = memo(LazyImageComponent);

LazyImage.displayName = 'LazyImage';

/**
 * Simple lazy image with default placeholder
 */
export const SimpleLazyImage = memo<Omit<LazyImageProps, 'placeholder'>>((props) => (
  <LazyImage {...props} />
));

SimpleLazyImage.displayName = 'SimpleLazyImage';

export default LazyImage;

