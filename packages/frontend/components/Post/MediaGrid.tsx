import React, { useState } from 'react';
import { View, Image, TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
// import { Ionicons } from '@expo/vector-icons';
import { MediaItem } from '@/interfaces/Post';
import { colors } from '@/styles/colors';

interface MediaGridProps {
    media: MediaItem[];
    onMediaPress?: (media: MediaItem, index: number) => void;
}

const GRID_SPACING = 4;

const MediaGrid: React.FC<MediaGridProps> = ({ media, onMediaPress }) => {
    const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

    if (!media || media.length === 0) {
        return null;
    }

    const handleImageError = (mediaId: string) => {
        setImageErrors(prev => new Set(prev).add(mediaId));
    };

    const handleMediaPress = (item: MediaItem, index: number) => {
        if (onMediaPress) {
            onMediaPress(item, index);
        } else {
            // Default behavior
            if (item.type === 'file') {
                Alert.alert('File', `${item.filename || 'Unknown file'}\nSize: ${formatFileSize(item.size || 0)}`);
            }
        }
    };

    const formatFileSize = (bytes: number): string => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const formatDuration = (seconds: number): string => {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    };

    const renderMediaItem = (item: MediaItem, index: number, itemStyle: any = {}) => {
        const hasError = imageErrors.has(item.id);

        return (
            <TouchableOpacity
                key={item.id}
                style={[styles.mediaItem, itemStyle]}
                onPress={() => handleMediaPress(item, index)}
                activeOpacity={0.8}
            >
                {item.type === 'image' && !hasError && (
                    <>
                        <Image
                            source={{ uri: item.url }}
                            style={styles.mediaImage}
                            onError={() => handleImageError(item.id)}
                            resizeMode="cover"
                        />
                        {item.alt && (
                            <View style={styles.altTextBadge}>
                                <Text style={styles.altText}>ALT</Text>
                            </View>
                        )}
                    </>
                )}

                {item.type === 'video' && (
                    <>
                        <Image
                            source={{ uri: item.thumbnail || item.url }}
                            style={styles.mediaImage}
                            onError={() => handleImageError(item.id)}
                            resizeMode="cover"
                        />
                        <View style={styles.videoOverlay}>
                            <View style={styles.playButton}>
                                <Text style={styles.playButtonText}>▶</Text>
                            </View>
                        </View>
                        {item.duration && (
                            <View style={styles.durationBadge}>
                                <Text style={styles.durationText}>{formatDuration(item.duration)}</Text>
                            </View>
                        )}
                    </>
                )}

                {(item.type === 'file' || hasError) && (
                    <View style={styles.fileContainer}>
                        <Text style={styles.fileIcon}>
                            {item.type === 'file' ? '📄' : '🖼️'}
                        </Text>
                        <Text style={styles.fileName} numberOfLines={2}>
                            {item.filename || item.alt || 'File'}
                        </Text>
                        {item.size && (
                            <Text style={styles.fileSize}>{formatFileSize(item.size)}</Text>
                        )}
                    </View>
                )}
            </TouchableOpacity>
        );
    };

    const renderGrid = () => {
        const count = media.length;

        if (count === 1) {
            return renderMediaItem(media[0], 0, styles.singleItem);
        }

        if (count === 2) {
            return (
                <View style={styles.doubleGrid}>
                    {media.map((item, index) =>
                        renderMediaItem(item, index, styles.doubleItem)
                    )}
                </View>
            );
        }

        if (count === 3) {
            return (
                <View style={styles.tripleGrid}>
                    {renderMediaItem(media[0], 0, styles.tripleLeftItem)}
                    <View style={styles.tripleRightColumn}>
                        {media.slice(1).map((item, index) =>
                            renderMediaItem(item, index + 1, styles.tripleRightItem)
                        )}
                    </View>
                </View>
            );
        }

        if (count === 4) {
            return (
                <View style={styles.quadGrid}>
                    <View style={styles.quadColumn}>
                        {media.slice(0, 2).map((item, index) =>
                            renderMediaItem(item, index, styles.quadItem)
                        )}
                    </View>
                    <View style={styles.quadColumn}>
                        {media.slice(2).map((item, index) =>
                            renderMediaItem(item, index + 2, styles.quadItem)
                        )}
                    </View>
                </View>
            );
        }

        // For 5+ items, show first 4 with "+" indicator
        return (
            <View style={styles.multiGrid}>
                <View style={styles.multiColumn}>
                    {media.slice(0, 2).map((item, index) =>
                        renderMediaItem(item, index, styles.multiItem)
                    )}
                </View>
                <View style={styles.multiColumn}>
                    {renderMediaItem(media[2], 2, styles.multiItem)}
                    <TouchableOpacity
                        style={[styles.mediaItem, styles.multiItem]}
                        onPress={() => handleMediaPress(media[3], 3)}
                    >
                        {renderMediaItem(media[3], 3, styles.multiItem)}
                        {count > 4 && (
                            <View style={styles.moreOverlay}>
                                <Text style={styles.moreText}>+{count - 4}</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        );
    };

    return (
        <View style={styles.container}>
            {renderGrid()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        marginTop: 12,
        marginBottom: 8,
        width: '100%',
    },
    mediaItem: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        position: 'relative',
    },
    mediaImage: {
        width: '100%',
        height: '100%',
    },
    fileContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    fileName: {
        fontSize: 12,
        fontWeight: '500',
        color: colors.COLOR_BLACK_LIGHT_2,
        textAlign: 'center',
        marginTop: 8,
    },
    fileSize: {
        fontSize: 10,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
    videoOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
    },
    durationBadge: {
        position: 'absolute',
        bottom: 8,
        right: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    durationText: {
        color: 'white',
        fontSize: 10,
        fontWeight: '500',
    },
    altTextBadge: {
        position: 'absolute',
        bottom: 8,
        left: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    altText: {
        color: 'white',
        fontSize: 10,
        fontWeight: '500',
    },
    moreOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    moreText: {
        color: 'white',
        fontSize: 18,
        fontWeight: 'bold',
    },
    // Single item layout
    singleItem: {
        width: '100%',
        aspectRatio: 16 / 10,
        maxHeight: 300,
    },
    // Double item layout
    doubleGrid: {
        flexDirection: 'row',
        gap: GRID_SPACING,
        width: '100%',
    },
    doubleItem: {
        flex: 1,
        aspectRatio: 1,
        maxHeight: 200,
    },
    // Triple item layout
    tripleGrid: {
        flexDirection: 'row',
        gap: GRID_SPACING,
        width: '100%',
        height: 260,
    },
    tripleLeftItem: {
        flex: 1,
        height: '100%',
    },
    tripleRightColumn: {
        flex: 1,
        gap: GRID_SPACING,
    },
    tripleRightItem: {
        flex: 1,
    },
    // Quad item layout
    quadGrid: {
        flexDirection: 'row',
        gap: GRID_SPACING,
        width: '100%',
        height: 240,
    },
    quadColumn: {
        flex: 1,
        gap: GRID_SPACING,
    },
    quadItem: {
        flex: 1,
    },
    // Multi item layout (5+)
    multiGrid: {
        flexDirection: 'row',
        gap: GRID_SPACING,
        width: '100%',
        height: 200,
    },
    multiColumn: {
        flex: 1,
        gap: GRID_SPACING,
    },
    multiItem: {
        flex: 1,
    },
    fileIcon: {
        fontSize: 40,
    },
    playButton: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    playButtonText: {
        color: 'white',
        fontSize: 24,
        marginLeft: 3,
    },
});

export default MediaGrid; 