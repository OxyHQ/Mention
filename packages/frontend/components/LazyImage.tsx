import React, { useState, useEffect, useRef } from 'react';
import { Image, ImageProps, View, StyleSheet, ViewStyle, ImageStyle, StyleProp } from 'react-native';

interface LazyImageProps extends Omit<ImageProps, 'source' | 'style'> {
    source: { uri: string } | number;
    placeholder?: React.ReactNode;
    fallback?: React.ReactNode;
    threshold?: number; // Distance from viewport to start loading (in pixels)
    containerStyle?: ViewStyle | ViewStyle[]; // Style for the container View
    style?: StyleProp<ImageStyle>; // Style for the Image itself
}

/**
 * LazyImage component that only loads images when they're near the viewport
 * Improves initial load performance by deferring off-screen images
 */
export const LazyImage: React.FC<LazyImageProps> = ({
    source,
    placeholder,
    fallback,
    threshold = 200,
    containerStyle,
    style,
    ...imageProps
}) => {
    const [shouldLoad, setShouldLoad] = useState(false);
    const [hasError, setHasError] = useState(false);
    const viewRef = useRef<View>(null);

    useEffect(() => {
        if (shouldLoad || typeof source === 'number') {
            // Number sources (require) don't need lazy loading
            setShouldLoad(true);
            return;
        }

        if (!source.uri) {
            return;
        }

        let observer: IntersectionObserver | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        // For web, use IntersectionObserver if available
        if (typeof window !== 'undefined' && 'IntersectionObserver' in window && viewRef.current) {
            observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            setShouldLoad(true);
                            observer?.disconnect();
                        }
                    });
                },
                {
                    rootMargin: `${threshold}px`,
                }
            );

            // Try to find the DOM element
            const element = (viewRef.current as any)?._nativeNode ||
                (viewRef.current as any)?.getNode?.() ||
                (viewRef.current as any);

            if (element && element.nodeType !== undefined) {
                observer.observe(element);
            } else {
                // If element not found, fall through to timer
                observer = null;
            }
        }

        // Fallback: load immediately for native platforms or if IntersectionObserver fails
        if (!observer) {
            timer = setTimeout(() => {
                setShouldLoad(true);
            }, 50);
        }

        return () => {
            observer?.disconnect();
            if (timer) clearTimeout(timer);
        };
    }, [source, threshold]);

    // Handle image load errors
    const handleError = () => {
        setHasError(true);
        if (imageProps.onError) {
            imageProps.onError({} as any);
        }
    };

    // If error and fallback provided, show fallback
    if (hasError && fallback) {
        return <View style={containerStyle}>{fallback}</View>;
    }

    // If not loaded yet, show placeholder
    if (!shouldLoad && placeholder) {
        return <View ref={viewRef} style={containerStyle}>{placeholder}</View>;
    }

    // Extract resizeMode from imageProps to ensure it's passed as a prop, not in style
    const { resizeMode, ...restImageProps } = imageProps;

    // Load the image
    return (
        <View ref={viewRef} style={containerStyle}>
            <Image
                {...restImageProps}
                source={shouldLoad || typeof source === 'number' ? source : { uri: '' }}
                onError={handleError}
                style={style}
                resizeMode={resizeMode}
            />
        </View>
    );
};

/**
 * Simple lazy image that uses a default placeholder
 */
export const SimpleLazyImage: React.FC<Omit<LazyImageProps, 'placeholder'>> = (props) => {
    return (
        <LazyImage
            {...props}
            placeholder={
                <View style={[StyleSheet.absoluteFill, { backgroundColor: '#f0f0f0' }]} />
            }
        />
    );
};

