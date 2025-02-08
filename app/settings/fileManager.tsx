import React, { useState } from 'react';
import { View, Pressable, Image, StyleSheet, ActivityIndicator } from 'react-native';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { useSelector } from "react-redux";
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Colors } from '@/constants/Colors';

export interface FileType {
    _id: string;
    contentType: string;
    uri: string;
}

interface RootState {
    session: {
        user: {
            _id: string;
        } | null;
    };
}

const MAX_FILES = 5;
const ALLOWED_FILE_TYPES = ["image/", "video/"];

export const FileManager: React.FC = () => {
    const [isModalVisible, setModalVisible] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const currentUser = useSelector((state: RootState) => state.session?.user);

    const handleFileSelection = async (files: FileType[]) => {
        try {
            setIsLoading(true);
            setError(null);
            const fileUris = files.map(file => `/api/files/${file._id}`);
            setSelectedFiles(prev => [...prev, ...fileUris]);
        } catch (err) {
            setError('Failed to process selected files. Please try again.');
            console.error('File selection error:', err);
        } finally {
            setIsLoading(false);
            setModalVisible(false);
        }
    };

    const handleRemoveFile = (index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    };

    if (!currentUser?._id) {
        return (
            <ThemedView style={styles.container}>
                <ThemedText style={styles.errorText}>
                    Please log in to manage files
                </ThemedText>
            </ThemedView>
        );
    }

    return (
        <ThemedView style={styles.container}>
            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed
                ]}
                onPress={() => setModalVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Select files"
            >
                <ThemedText style={styles.buttonText}>
                    Select Files
                </ThemedText>
            </Pressable>

            {isLoading && (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={Colors.light.tint} />
                </View>
            )}

            {error && (
                <ThemedText style={styles.errorText}>{error}</ThemedText>
            )}

            <FileSelectorModal
                visible={isModalVisible}
                onClose={() => setModalVisible(false)}
                onSelect={handleFileSelection}
                options={{
                    fileTypeFilter: ALLOWED_FILE_TYPES,
                    maxFiles: MAX_FILES,
                }}
            />

            <View style={styles.imageGrid}>
                {selectedFiles.map((file, index) => (
                    <Pressable
                        key={`${file}-${index}`}
                        onLongPress={() => handleRemoveFile(index)}
                        style={styles.imageContainer}
                        accessibilityLabel={`Remove file ${index + 1}`}
                        accessibilityHint="Long press to remove this file"
                    >
                        <Image
                            source={{ uri: file }}
                            style={styles.image}
                            resizeMode="cover"
                        />
                    </Pressable>
                ))}
            </View>
        </ThemedView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    button: {
        backgroundColor: Colors.light.tint,
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
    loadingContainer: {
        marginVertical: 20,
        alignItems: 'center',
    },
    imageGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 20,
        gap: 8,
    },
    imageContainer: {
        width: '31%',
        aspectRatio: 1,
        marginBottom: 8,
    },
    image: {
        width: '100%',
        height: '100%',
        borderRadius: 8,
    },
    errorText: {
        color: '#FF4D4D', // Using a standard error color instead of Colors.light.error
        textAlign: 'center',
        marginVertical: 16,
    },
});

export default FileManager;