import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/sonner';
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import api from '@/utils/api';
import { DocumentPickerAsset } from 'expo-document-picker';
import { ImagePickerAsset } from 'expo-image-picker';

interface FileType {
    _id: string;
    filename: string;
    contentType: string;
    uploadDate: string;
    length: number;
    metadata?: {
        userID: string;
        originalname?: string;
    };
}

interface UseFilesOptions {
    fileTypeFilter?: string[];
    maxFiles?: number;
    userId?: string;
}

export function useFiles({ fileTypeFilter = [], maxFiles = 5, userId }: UseFilesOptions = {}) {
    const [files, setFiles] = useState<FileType[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const { t } = useTranslation();

    const fetchFiles = useCallback(async () => {
        if (!userId) {
            toast.error(t("User not authenticated"));
            return;
        }

        try {
            setLoading(true);
            const response = await api.get(`/files/list/${userId}`);
            let fetchedFiles = response.data;
            
            if (fileTypeFilter.length > 0) {
                fetchedFiles = fetchedFiles.filter((file: FileType) => 
                    fileTypeFilter.some(type => file.contentType.startsWith(type))
                );
            }
            
            setFiles(fetchedFiles);
        } catch (error: any) {
            console.error("Fetch error:", error);
            toast.error(error?.response?.data?.message || t("Error fetching files"));
        } finally {
            setLoading(false);
        }
    }, [userId, fileTypeFilter, t]);

    const uploadFiles = useCallback(async () => {
        if (!userId) {
            toast.error(t("User not authenticated"));
            return;
        }

        try {
            let result;
            if (fileTypeFilter.includes("image/") || fileTypeFilter.includes("video/")) {
                result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ImagePicker.MediaTypeOptions.All,
                    allowsMultipleSelection: true,
                    quality: 1,
                });
            } else {
                result = await DocumentPicker.getDocumentAsync({
                    type: fileTypeFilter.length > 0 ? fileTypeFilter.map(type => `${type}*`).join(",") : "*/*",
                    multiple: true,
                });
            }

            if (!result.canceled && result.assets && result.assets.length > 0) {
                setUploading(true);
                const formData = new FormData();

                for (const asset of result.assets) {
                    const fileUri = Platform.OS === 'ios' ? asset.uri.replace('file://', '') : asset.uri;
                    
                    let fileName: string;
                    let fileType: string;
                    
                    if ('mimeType' in asset) {
                        fileName = (asset as DocumentPickerAsset).name;
                        fileType = (asset as DocumentPickerAsset).mimeType || 'application/octet-stream';
                    } else {
                        const extension = fileUri.split('.').pop() || 'jpg';
                        fileName = `image-${Date.now()}.${extension}`;
                        fileType = (asset as ImagePickerAsset).type || `image/${extension}`;
                    }

                    const response = await fetch(fileUri);
                    const blob = await response.blob();
                    const file = new File([blob], fileName, { type: fileType });
                    formData.append('files', file);
                }

                const response = await api.post('/files/upload', formData, {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'multipart/form-data',
                    },
                    transformRequest: [(data) => data],
                });

                if (response.data?.files) {
                    toast.success(t("Files uploaded successfully"));
                    await fetchFiles();
                }
            }
        } catch (error: any) {
            console.error("Upload error:", error);
            toast.error(error?.response?.data?.message || t("Error uploading files"));
        } finally {
            setUploading(false);
        }
    }, [userId, fileTypeFilter, t, fetchFiles]);

    const deleteFile = useCallback(async (fileId: string) => {
        try {
            await api.delete(`/files/${fileId}`);
            toast.success(t("File deleted successfully"));
            await fetchFiles();
        } catch (error: any) {
            console.error("Delete error:", error);
            toast.error(error?.response?.data?.message || t("Error deleting file"));
        }
    }, [t, fetchFiles]);

    return {
        files,
        loading,
        uploading,
        fetchFiles,
        uploadFiles,
        deleteFile
    };
}