import React, { useState, useCallback, memo } from 'react';
import { View, Text, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from "@expo/vector-icons";
import { fileItemStyles as styles } from './styles';
import { FileItemProps } from './types';
import { colors } from '@/styles/colors';

// Using memo to prevent re-renders when props haven't changed
export const FileItem = memo(({
    file,
    isSelected,
    onSelect,
    onDelete,
    baseUrl
}: FileItemProps) => {
    const [imageLoading, setImageLoading] = useState(true);
    const isImage = file.contentType.startsWith("image/");
    const isVideo = file.contentType.startsWith("video/");
    const fileUri = `${baseUrl}${file._id}`;
    const fileSize = (file.length / (1024 * 1024)).toFixed(1);

    // Using useCallback to memoize these handlers
    const handleSelect = useCallback(() => {
        onSelect(file);
    }, [file, onSelect]);

    const handleLongPress = useCallback(() => {
        onDelete(file._id);
    }, [file._id, onDelete]);

    return (
        <TouchableOpacity
            onPress={handleSelect}
            onLongPress={handleLongPress}
            style={[styles.container, isSelected && styles.selected]}
        >
            {isImage && (
                <>
                    <Image
                        source={{ uri: fileUri }}
                        style={styles.preview}
                        onLoadStart={() => setImageLoading(true)}
                        onLoadEnd={() => setImageLoading(false)}
                    />
                    {imageLoading && (
                        <View style={styles.loadingOverlay}>
                            <ActivityIndicator size="small" color={colors.primaryColor} />
                        </View>
                    )}
                </>
            )}
            {isVideo && (
                <Video
                    source={{ uri: fileUri }}
                    style={styles.preview}
                    resizeMode={ResizeMode.COVER}
                    shouldPlay={false}
                    isMuted={true}
                />
            )}
            {!isImage && !isVideo && (
                <View style={styles.preview}>
                    <Ionicons name="document" size={48} color={colors.COLOR_BLACK_LIGHT_4} />
                </View>
            )}
            {isSelected && (
                <View style={[styles.indicator, styles.checkmark]}>
                    <Ionicons name="checkmark-circle" size={20} color="white" />
                </View>
            )}
            <View style={[styles.indicator, styles.fileInfo]}>
                <Text style={styles.fileInfoText}>{`${fileSize}MB`}</Text>
            </View>
            <View style={styles.overlay}>
                <Text style={styles.fileName} numberOfLines={2}>
                    {file.metadata?.originalname || file.filename}
                </Text>
            </View>
        </TouchableOpacity>
    );
}, (prevProps, nextProps) => {
    // Custom comparison function for memo
    // Only re-render if these props change
    return (
        prevProps.file._id === nextProps.file._id &&
        prevProps.isSelected === nextProps.isSelected &&
        prevProps.baseUrl === nextProps.baseUrl
    );
});