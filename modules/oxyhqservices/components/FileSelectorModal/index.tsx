import React, { useState, useEffect, useCallback, useRef, useContext, useMemo } from "react";
import { Modal, View, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Text, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { Header } from "../ui/Header";
import { useFiles } from '../../hooks/useFiles';
import { FileItem } from './FileItem';
import { modalStyles, gridStyles, controlStyles } from './styles';
import { FileType, FileSelectorModalProps } from './types';
import { OXY_CLOUD_URL } from "../../config";
import { SessionContext } from '../SessionProvider';
import { FlashList } from "@shopify/flash-list";

const defaultFileTypes = ["image/", "video/", "application/pdf", "image/gif"];

const FileSelectorModal: React.FC<FileSelectorModalProps> = ({
    isVisible,
    onClose,
    onSelect,
    options = {}
}) => {
    const { fileTypeFilter = defaultFileTypes, maxFiles = 5 } = options;
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [filterText, setFilterText] = useState("");
    const { t } = useTranslation();

    // Use SessionContext instead of useAuth
    const sessionContext = useContext(SessionContext);
    const currentUserId = sessionContext?.getCurrentUserId();

    // Cache reference for performance
    const selectedFilesRef = useRef<string[]>([]);

    // Use a Map for faster lookups instead of array includes
    const selectedFilesMapRef = useRef<Map<string, boolean>>(new Map());

    // Use a ref to track whether files have been fetched
    const hasFetchedRef = useRef(false);

    // Cache for file data to prevent unnecessary re-renders
    const fileCache = useRef<Map<string, FileType>>(new Map());

    const {
        files,
        loading,
        uploading,
        fetchFiles,
        uploadFiles,
        deleteFile
    } = useFiles({
        fileTypeFilter,
        maxFiles,
        userId: currentUserId || undefined
    });

    // Update the ref when selectedFiles changes
    useEffect(() => {
        selectedFilesRef.current = selectedFiles;

        // Update the Map for faster lookups
        selectedFilesMapRef.current.clear();
        selectedFiles.forEach(id => selectedFilesMapRef.current.set(id, true));
    }, [selectedFiles]);

    // Cache files for better performance
    useEffect(() => {
        files.forEach(file => {
            fileCache.current.set(file._id, file);
        });
    }, [files]);

    // Updated useEffect to fetch only once per modal open using ref
    useEffect(() => {
        if (isVisible && currentUserId && !hasFetchedRef.current) {
            fetchFiles();
            hasFetchedRef.current = true;
        } else if (!isVisible) {
            // Reset state when modal closes
            setSelectedFiles([]);
            setFilterText("");
            hasFetchedRef.current = false;
            selectedFilesMapRef.current.clear();
        }
    }, [isVisible, currentUserId, fetchFiles]);

    // Wrap handleDone in useCallback to keep its identity stable
    const handleDone = useCallback(() => {
        const selectedFileObjects = files.filter(file => selectedFilesMapRef.current.has(file._id));
        onSelect(selectedFileObjects);
        onClose();
    }, [files, onSelect, onClose]);

    const handleSelectFile = useCallback((file: FileType) => {
        setSelectedFiles(prev => {
            // Use the Map for faster lookups
            const isSelected = selectedFilesMapRef.current.has(file._id);

            if (isSelected) {
                // Remove from selection
                selectedFilesMapRef.current.delete(file._id);
                return prev.filter(id => id !== file._id);
            }

            if (prev.length >= maxFiles) {
                return prev;
            }

            // Add to selection
            selectedFilesMapRef.current.set(file._id, true);
            return [...prev, file._id];
        });
    }, [maxFiles]);

    const handleDeleteFile = useCallback(async (fileId: string) => {
        if (window.confirm(t('Are you sure you want to delete this file?'))) {
            await deleteFile(fileId);

            // Remove from selection if selected
            if (selectedFilesMapRef.current.has(fileId)) {
                selectedFilesMapRef.current.delete(fileId);
                setSelectedFiles(prev => prev.filter(id => id !== fileId));
            }

            // Remove from cache
            fileCache.current.delete(fileId);
        }
    }, [t, deleteFile]);

    // Memoize filtered files with useMemo for better performance
    const filteredFiles = useMemo(() =>
        files.filter(file =>
            file.filename.toLowerCase().includes(filterText.toLowerCase()) ||
            file.metadata?.originalname?.toLowerCase().includes(filterText.toLowerCase())
        ),
        [files, filterText]
    );

    const renderEmptyState = useCallback(() => (
        <View style={gridStyles.empty}>
            <Ionicons name="cloud-upload-outline" size={64} color="#999" />
            <Text style={gridStyles.emptyText}>
                {t("No files found. Upload some files to get started!")}
            </Text>
        </View>
    ), [t]);

    // Memoize Header options to avoid unnecessary re-creations
    const headerOptions = useMemo(() => ({
        title: t("File Manager"),
        leftComponents: [
            <TouchableOpacity key="back" onPress={onClose}>
                <Ionicons name="arrow-back" size={24} color="black" />
            </TouchableOpacity>
        ],
        rightComponents: [
            <Text key="count" style={controlStyles.buttonText}>
                {selectedFiles.length}/{maxFiles}
            </Text>
        ],
    }), [onClose, selectedFiles.length, maxFiles, t]);

    // Handle keyboard shortcuts
    const handleKeyPress = useCallback((event: KeyboardEvent) => {
        if (!isVisible) return;

        if (event.key === 'Escape') {
            onClose();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            if (selectedFilesRef.current.length > 0) {
                handleDone();
            }
        } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            const remainingSlots = maxFiles - selectedFilesRef.current.length;
            if (remainingSlots > 0) {
                const newFiles = files
                    .filter(file => !selectedFilesMapRef.current.has(file._id))
                    .slice(0, remainingSlots)
                    .map(file => file._id);

                setSelectedFiles(prev => [...prev, ...newFiles]);
            }
        }
    }, [isVisible, files, maxFiles, handleDone, onClose]);

    // Add keyboard event listeners for web platform
    useEffect(() => {
        if (Platform.OS === 'web') {
            window.addEventListener('keydown', handleKeyPress);
            return () => window.removeEventListener('keydown', handleKeyPress);
        }
    }, [handleKeyPress]);

    // Prevent scrolling of background content when modal is open
    useEffect(() => {
        if (Platform.OS === 'web' && isVisible) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [isVisible]);

    // Memoize the file item renderer for better performance
    const renderFileItem = useCallback(({ item }: { item: FileType }) => {
        const isItemSelected = selectedFilesMapRef.current.has(item._id);

        return (
            <FileItem
                file={item}
                isSelected={isItemSelected}
                onSelect={handleSelectFile}
                onDelete={handleDeleteFile}
                baseUrl={OXY_CLOUD_URL}
            />
        );
    }, [handleSelectFile, handleDeleteFile]);

    // Memoize the key extractor for better performance
    const keyExtractor = useCallback((item: FileType) => item._id, []);

    // Memoize the FlatList component for better performance
    const FilesList = useMemo(() => {
        if (loading || uploading) {
            return (
                <View style={gridStyles.empty}>
                    <ActivityIndicator size="large" color="#0066FF" />
                    <Text style={gridStyles.emptyText}>
                        {uploading ? t("Uploading files...") : t("Loading files...")}
                    </Text>
                </View>
            );
        }

        if (Platform.OS === 'web') {
            return (
                <FlatList
                    data={filteredFiles}
                    renderItem={renderFileItem}
                    keyExtractor={keyExtractor}
                    numColumns={2}
                    contentContainerStyle={gridStyles.container}
                    ListEmptyComponent={renderEmptyState}
                    initialNumToRender={10}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    removeClippedSubviews={true}
                    getItemLayout={(data, index) => ({
                        length: 200, // Approximate height of each item
                        offset: 200 * Math.floor(index / 2), // Calculate offset based on row
                        index,
                    })}
                />
            );
        }

        return (
            <FlashList
                data={filteredFiles}
                renderItem={renderFileItem}
                keyExtractor={keyExtractor}
                numColumns={2}
                contentContainerStyle={gridStyles.container}
                ListEmptyComponent={renderEmptyState}
                estimatedItemSize={200}
            />
        );
    }, [filteredFiles, loading, uploading, renderFileItem, keyExtractor, renderEmptyState, t]);

    return (
        <Modal
            visible={isVisible}
            transparent
            animationType="fade"
            onRequestClose={onClose} // Handle back button on Android
        >
            <View
                style={modalStyles.background}
                onTouchEnd={(e) => {
                    if (e.target === e.currentTarget) {
                        onClose(); // Close on background click
                    }
                }}
            >
                <View style={[
                    modalStyles.container,
                    Platform.OS === 'web' && { maxHeight: '90vh' as any }
                ]}>
                    <Header options={headerOptions} />

                    <View style={controlStyles.filterContainer}>
                        <TextInput
                            style={controlStyles.input}
                            placeholder={t("Search files...")}
                            value={filterText}
                            onChangeText={setFilterText}
                            autoFocus={Platform.OS === 'web'} // Autofocus on web
                        />
                        {Platform.OS === 'web' && (
                            <Text style={controlStyles.shortcutHint}>
                                {t("Press Esc to close, Ctrl+Enter to confirm")}
                            </Text>
                        )}
                    </View>

                    {FilesList}

                    <View style={controlStyles.buttonsContainer}>
                        <TouchableOpacity
                            onPress={onClose}
                            style={[controlStyles.button, controlStyles.buttonCancel]}
                        >
                            <Text style={[controlStyles.buttonText, controlStyles.buttonTextCancel]}>
                                {t("Cancel")}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={handleDone}
                            style={[
                                controlStyles.button,
                                controlStyles.buttonDone,
                                selectedFiles.length === 0 && controlStyles.buttonDisabled
                            ]}
                            disabled={selectedFiles.length === 0}
                        >
                            <Text style={[controlStyles.buttonText, controlStyles.buttonTextDone]}>
                                {t("Select")} ({selectedFiles.length})
                            </Text>
                        </TouchableOpacity>
                    </View>

                    <TouchableOpacity
                        style={[
                            controlStyles.uploadButton,
                            uploading && controlStyles.buttonDisabled
                        ]}
                        onPress={uploadFiles}
                        disabled={uploading}
                    >
                        <Ionicons
                            name={uploading ? "hourglass" : "cloud-upload"}
                            size={24}
                            color="white"
                        />
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
};

export default FileSelectorModal;
