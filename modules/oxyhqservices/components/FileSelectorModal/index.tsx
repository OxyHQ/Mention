import React, { useState, useEffect } from "react";
import { Modal, View, Text, FlatList, TouchableOpacity, ActivityIndicator, Button, StyleSheet, Image, ScrollView, TextInput } from "react-native";
import * as ImagePicker from "expo-image-picker";
import axios from "axios";
import { toast } from '@/lib/sonner';
import { ProgressCircle } from 'react-native-svg-charts';
import { Ionicons } from "@expo/vector-icons";
import { Header } from "@/modules/oxyhqservices/components/ui/Header";
import { colors } from "@/styles/colors";
import * as DocumentPicker from 'expo-document-picker';
import { Video, ResizeMode } from 'expo-av';

interface FileSelectorModalProps {
    visible: boolean;
    onClose: () => void;
    onSelect: (files: any[]) => void; // Change to array of files
    userId: string;
    options?: {
        fileTypeFilter?: string[];
        maxFiles?: number;
    };
}

const defaultFileTypes = ["image/", "video/", "application/pdf", "image/gif"]; // Default allowed types

const FileSelectorModal: React.FC<FileSelectorModalProps> = ({ visible, onClose, onSelect, userId, options = {} }) => {
    const { fileTypeFilter = defaultFileTypes, maxFiles = 5 } = options;
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [filterText, setFilterText] = useState("");
    const [filterDate, setFilterDate] = useState("");
    const [filterType, setFilterType] = useState("");

    useEffect(() => {
        fetchFiles();
    }, [visible]);

    const fetchFiles = async () => {
        try {
            setLoading(true);
            const response = await axios.get(`https://api.mention.earth/api/files/list/678b29d19085a13337ca9fd3`);
            let fetchedFiles = response.data;
            fetchedFiles = fetchedFiles.filter((file: File) => fileTypeFilter.some((type: string) => file.contentType.startsWith(type)));
            setFiles(fetchedFiles);
            setSelectedFiles([]);
        } catch (error) {
            toast.error("Error fetching files");
            setTimeout(() => {
                fetchFiles();
            }, 10000);
        } finally {
            setLoading(false);
        }
    };

    const uploadFile = async () => {
        try {
            let result;
            if (fileTypeFilter.includes("image/") || fileTypeFilter.includes("video/")) {
                result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ['images', 'videos'],
                    allowsEditing: true,
                    allowsMultipleSelection: true,
                    quality: 1,
                });
            } else {
                result = await DocumentPicker.getDocumentAsync({
                    type: fileTypeFilter.length > 0 ? fileTypeFilter.map(type => `${type}*`).join(",") : "*/*",
                });
            }

            if (!result.canceled) {
                if (result.assets.length + selectedFiles.length > maxFiles) {
                    toast.error(`You can only select up to ${maxFiles} files.`);
                    return;
                }

                const formData = new FormData();

                await Promise.all(result.assets.map(async (asset) => {
                    const fileName = 'name' in asset ? asset.name : asset.uri.split('/').pop();
                    const response = await fetch(asset.uri);
                    const blob = await response.blob();
                    formData.append('files', blob, fileName);
                }));

                formData.append("userId", userId);

                await axios.post("https://api.mention.earth/api/files/upload", formData, {
                    headers: {
                        'Content-Type': 'multipart/form-data',
                    },
                });
                fetchFiles();
            }
        } catch (error) {
            toast.error("Error uploading file");
            console.error("Error uploading file:", error);
        }
    };

    const handleSelectFile = (file) => {
        if (selectedFiles.includes(file._id)) {
            setSelectedFiles(selectedFiles.filter(id => id !== file._id));
        } else {
            if (selectedFiles.length < maxFiles) {
                setSelectedFiles([...selectedFiles, file._id]);
            } else {
                toast.error(`You can only select up to ${maxFiles} files.`);
            }
        }
    };

    const handleDone = () => {
        const selectedFileObjects = files.filter(file => selectedFiles.includes(file._id));
        console.log("Selected files:", selectedFileObjects);
        onSelect(selectedFileObjects);
        onClose();
    };

    const filteredFiles = files.filter(file =>
        file.filename.toLowerCase().includes(filterText.toLowerCase()) &&
        (!filterDate || new Date(file.uploadDate).toLocaleDateString().includes(filterDate)) &&
        (!filterType || file.contentType.includes(filterType))
    );

    const renderFileItem = ({ item }) => {
        const isImage = item.contentType.startsWith("image/");
        const isVideo = item.contentType.startsWith("video/");
        const fileUri = `https://api.mention.earth/api/files/${item._id}`;
        const isSelected = selectedFiles.includes(item._id);

        return (
            <TouchableOpacity onPress={() => handleSelectFile(item)} style={[styles.fileItem, isSelected && styles.selectedFileItem]}>
                {isImage && <Image source={{ uri: fileUri }} style={styles.filePreview} />}
                {isVideo && <Video source={{ uri: fileUri }} style={styles.filePreview} />}
                <View style={styles.fileOverlay}>
                    <Text style={styles.fileName}>{item.filename}</Text>
                </View>
            </TouchableOpacity>
        );
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <View style={styles.modalBackground}>
                <View style={styles.modalParent}>
                    <Header options={{
                        leftComponents: [<Ionicons name="settings" size={24} color={colors.COLOR_BLACK} />],
                        title: 'File Manager',
                        rightComponents: [
                            <View style={styles.limitContainer}>
                                <Text style={styles.limitText}>{selectedFiles.length}/{maxFiles}</Text>
                                <ProgressCircle
                                    style={styles.progressCircle}
                                    progress={selectedFiles.length / maxFiles}
                                    progressColor={colors.primaryColor}
                                    backgroundColor={colors.primaryLight_1}
                                />
                            </View>,
                            <Ionicons name="cloud-upload" size={24} color={colors.COLOR_BLACK} onPress={uploadFile} />,
                            <Ionicons name="close" size={24} color={colors.COLOR_BLACK} onPress={onClose} />],
                    }} />
                    <ScrollView style={styles.modalContainer}>
                        <View style={styles.filterContainer}>
                            <TextInput
                                style={styles.filterInput}
                                placeholder="Filter files by name"
                                value={filterText}
                                onChangeText={setFilterText}
                            />
                            <TextInput
                                style={styles.filterInput}
                                placeholder="Filter files by date (MM/DD/YYYY)"
                                value={filterDate}
                                onChangeText={setFilterDate}
                            />
                            <TextInput
                                style={styles.filterInput}
                                placeholder="Filter files by type (e.g., image, video)"
                                value={filterType}
                                onChangeText={setFilterType}
                            />
                        </View>
                        {loading ? (
                            <ActivityIndicator size="large" color={colors.primaryColor} />
                        ) : (
                            <FlatList
                                data={filteredFiles}
                                keyExtractor={(item) => item._id}
                                numColumns={2}
                                renderItem={renderFileItem}
                            />
                        )}
                    </ScrollView>
                    <View style={styles.buttonContainer}>
                        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                            <Text style={styles.closeButtonText}>Close</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={handleDone} style={[styles.doneButton, selectedFiles.length === 0 && styles.disabledButton]} disabled={selectedFiles.length === 0}>
                            <Text style={styles.doneButtonText}>Done</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalBackground: {
        flex: 1,
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.5)",
    },
    modalParent: {
        maxWidth: 900,
        width: "100%",
        margin: "auto",
        backgroundColor: "white",
        borderRadius: 35,
    },
    modalContainer: {
        width: "100%",
        height: "100%",
        minHeight: 500,
    },
    fileItem: {
        flex: 1,
        margin: 5,
        borderRadius: 35,
        overflow: "hidden",
        position: "relative",
        borderWidth: 2,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    selectedFileItem: {
        borderColor: colors.primaryColor,
    },
    fileName: {
        color: "white",
        fontWeight: "bold",
        textAlign: "center",
    },
    closeButton: {
        alignSelf: "flex-end",
        padding: 5,
    },
    closeButtonText: {
        color: "red",
    },
    doneButton: {
        alignSelf: "flex-end",
        marginLeft: 10,
        padding: 5,
    },
    doneButtonText: {
        color: "green",
    },
    disabledButton: {
        opacity: 0.5,
    },
    filePreview: {
        width: "100%",
        height: 150,
    },
    fileOverlay: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: `${colors.primaryColor}90`,
        padding: 5,
    },
    limitContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 5,
        backgroundColor: colors.COLOR_BACKGROUND,
        borderRadius: 35,
        gap: 5,
    },
    limitText: {
        fontSize: 16,
        color: colors.primaryColor,
        fontWeight: 900,
    },
    progressCircle: {
        height: 30,
        width: 30,
    },
    buttonContainer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    filterContainer: {
        padding: 10,
    },
    filterInput: {
        height: 40,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderWidth: 1,
        borderRadius: 5,
        paddingHorizontal: 10,
        marginBottom: 10,
    },
});

export default FileSelectorModal;
