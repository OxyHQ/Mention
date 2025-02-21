import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal, View, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Text, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import { Ionicons } from "@expo/vector-icons";
import { Header } from "../ui/Header";
import { useFiles } from '../../hooks/useFiles';
import { FileItem } from './FileItem';
import { modalStyles, gridStyles, controlStyles } from './styles';
import { FileType, FileSelectorModalProps } from './types';
import { OXY_CLOUD_URL } from "@/config";

const defaultFileTypes = ["image/", "video/", "application/pdf", "image/gif"];

const FileSelectorModal: React.FC<FileSelectorModalProps> = ({ 
    visible, 
    onClose, 
    onSelect, 
    options = {} 
}) => {
    const { fileTypeFilter = defaultFileTypes, maxFiles = 5 } = options;
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [filterText, setFilterText] = useState("");
    const { t } = useTranslation();
    const currentUser = useSelector((state: any) => state.session?.user);

    // Use a ref to track whether files have been fetched
    const hasFetchedRef = useRef(false);

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
        userId: currentUser?.id
    });

    // Updated useEffect to fetch only once per modal open using ref
    useEffect(() => {
        if (visible && currentUser?.id && !hasFetchedRef.current) {
            fetchFiles();
            hasFetchedRef.current = true;
        } else if (!visible) {
            hasFetchedRef.current = false;
        }
    }, [visible, currentUser?.id]); // removed fetchFiles from dependency array

    // Wrap handleDone in useCallback to keep its identity stable
    const handleDone = useCallback(() => {
        const selectedFileObjects = files.filter(file => selectedFiles.includes(file._id));
        onSelect(selectedFileObjects);
        onClose();
    }, [files, selectedFiles, onSelect, onClose]);

    const handleSelectFile = (file: FileType) => {
        setSelectedFiles(prev => {
            if (prev.includes(file._id)) {
                return prev.filter(id => id !== file._id);
            }
            if (prev.length >= maxFiles) {
                return prev;
            }
            return [...prev, file._id];
        });
    };

    const handleDeleteFile = async (fileId: string) => {
        if (window.confirm(t('Are you sure you want to delete this file?'))) {
            await deleteFile(fileId);
            setSelectedFiles(prev => prev.filter(id => id !== fileId));
        }
    };

    // Memoize filtered files
    const filteredFiles = React.useMemo(() => 
        files.filter(file =>
            file.filename.toLowerCase().includes(filterText.toLowerCase()) ||
            file.metadata?.originalname?.toLowerCase().includes(filterText.toLowerCase())
        ),
        [files, filterText]
    );

    const renderEmptyState = () => (
        <View style={gridStyles.empty}>
            <Ionicons name="cloud-upload-outline" size={64} color="#999" />
            <Text style={gridStyles.emptyText}>
                {t("No files found. Upload some files to get started!")}
            </Text>
        </View>
    );

    // Memoize Header options to avoid unnecessary re-creations
    const headerOptions = React.useMemo(() => ({
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
        if (!visible) return;

        if (event.key === 'Escape') {
            onClose();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            if (selectedFiles.length > 0) {
                handleDone();
            }
        } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            const remainingSlots = maxFiles - selectedFiles.length;
            if (remainingSlots > 0) {
                const newFiles = files
                    .filter(file => !selectedFiles.includes(file._id))
                    .slice(0, remainingSlots)
                    .map(file => file._id);
                setSelectedFiles(prev => [...prev, ...newFiles]);
            }
        }
    }, [visible, selectedFiles, files, maxFiles, handleDone, onClose]);

    // Add keyboard event listeners for web platform
    useEffect(() => {
        if (Platform.OS === 'web') {
            window.addEventListener('keydown', handleKeyPress);
            return () => window.removeEventListener('keydown', handleKeyPress);
        }
    }, [handleKeyPress]);

    // Prevent scrolling of background content when modal is open
    useEffect(() => {
        if (Platform.OS === 'web' && visible) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [visible]);

    return (
        <Modal 
            visible={visible} 
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

                    {(loading || uploading) ? (
                        <View style={gridStyles.empty}>
                            <ActivityIndicator size="large" color="#0066FF" />
                            <Text style={gridStyles.emptyText}>
                                {uploading ? t("Uploading files...") : t("Loading files...")}
                            </Text>
                        </View>
                    ) : (
                        <FlatList
                            data={filteredFiles}
                            renderItem={({ item }) => (
                                <FileItem
                                    file={item}
                                    isSelected={selectedFiles.includes(item._id)}
                                    onSelect={handleSelectFile}
                                    onDelete={handleDeleteFile}
                                    baseUrl={OXY_CLOUD_URL}
                                />
                            )}
                            keyExtractor={(item) => item._id}
                            numColumns={2}
                            contentContainerStyle={gridStyles.container}
                            ListEmptyComponent={renderEmptyState}
                        />
                    )}

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
