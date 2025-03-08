import { useState, useCallback, useRef, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import api, { validateSession } from '../utils/api';
import { getData, getSecureData } from '../utils/storage';
import { DocumentPickerAsset } from 'expo-document-picker';
import { ImagePickerAsset } from 'expo-image-picker';
import { jwtDecode } from 'jwt-decode';
import { refreshAccessToken } from '../utils/api';
import { SessionContext } from '../components/SessionProvider';
import { FileType, UseFilesOptions } from '../components/FileSelectorModal/types';
import { STORAGE_KEYS } from '../constants';

interface JwtPayload {
    id: string;
    username: string;
    iat: number;
    exp: number;
}

// Cache for files to improve performance across component instances
const globalFileCache = new Map<string, {
  files: FileType[];
  timestamp: number;
  userId: string;
}>();

// Cache expiration time (5 minutes)
const CACHE_EXPIRATION = 5 * 60 * 1000;

export function useFiles({ fileTypeFilter = [], maxFiles = 5, userId }: UseFilesOptions = {}) {
    const [files, setFiles] = useState<FileType[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    
    // Use a ref to track the abort controller for fetch operations
    const abortControllerRef = useRef<AbortController | null>(null);
    
    // Use a ref to track the current user ID for cleanup
    const currentUserIdRef = useRef<string | undefined>(userId);
    
    // Update the ref when userId changes
    useEffect(() => {
        currentUserIdRef.current = userId;
    }, [userId]);
    
    // Cleanup function for component unmount
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    const fetchFiles = useCallback(async (forceRefresh = false) => {
        try {
            const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
            const refreshToken = await getSecureData<string>(STORAGE_KEYS.REFRESH_TOKEN);
            
            if (!accessToken || !refreshToken) {
                console.warn('[Files] Missing auth tokens');
                setFiles([]);
                setLoading(false);
                return;
            }

            // Get current user ID from session context if not provided
            const effectiveUserId = userId || sessionContext?.getCurrentUserId();
            if (!effectiveUserId) {
                console.warn('[Files] No user ID available');
                setFiles([]);
                setLoading(false);
                return;
            }

            // Check cache first
            const cacheKey = `${effectiveUserId}-${fileTypeFilter.join(',')}`;
            const cachedData = globalFileCache.get(cacheKey);
            const now = Date.now();
            
            if (!forceRefresh && cachedData && (now - cachedData.timestamp < CACHE_EXPIRATION)) {
                console.log('[Files] Using cached files data');
                setFiles(cachedData.files);
                setLoading(false);
                return;
            }

            console.log('[Files] Fetching files for user:', effectiveUserId);
            setLoading(true);
            
            // Cancel any in-progress requests
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            
            abortControllerRef.current = new AbortController();
            const signal = abortControllerRef.current.signal;

            // Attempt token refresh only if needed
            const isValid = await validateSession().catch(() => false);
            if (!isValid) {
                console.log('[Files] Session invalid, refreshing token');
                try {
                    await refreshAccessToken();
                } catch (refreshError) {
                    console.error('[Files] Token refresh failed:', refreshError);
                    setFiles([]);
                    setLoading(false);
                    return;
                }
            }

            const response = await api.get(`/files/list/${effectiveUserId}`, {
                signal,
                params: forceRefresh ? { _t: Date.now() } : undefined
            });
            
            let fetchedFiles = response.data;
            
            if (fileTypeFilter.length > 0) {
                fetchedFiles = fetchedFiles.filter((file: FileType) => 
                    fileTypeFilter.some(type => file.contentType.startsWith(type))
                );
            }
            
            globalFileCache.set(cacheKey, {
                files: fetchedFiles,
                timestamp: now,
                userId: effectiveUserId
            });
            
            if (currentUserIdRef.current === effectiveUserId) {
                setFiles(fetchedFiles);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[Files] Fetch aborted');
                return;
            }
            
            console.error("[Files] Fetch error:", {
                userId,
                error: error?.response?.data || error.message,
                status: error?.response?.status
            });
            
            setFiles([]);
            toast.error(error?.response?.data?.message || t("Error fetching files"));
        } finally {
            if (currentUserIdRef.current === userId) {
                setLoading(false);
            }
        }
    }, [userId, fileTypeFilter, t, sessionContext]);

    const uploadFiles = useCallback(async () => {
        // Get current user ID from session context if not provided
        const effectiveUserId = userId || sessionContext?.getCurrentUserId() || undefined;
        
        if (!effectiveUserId) {
            toast.error(t("User not authenticated"));
            return;
        }

        try {
            const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
            if (!accessToken) {
                toast.error(t("Authentication required"));
                return;
            }

            let result;
            if (fileTypeFilter.includes("image/") || fileTypeFilter.includes("video/")) {
                result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: fileTypeFilter.includes("video/") ? 
                        ImagePicker.MediaTypeOptions.All : 
                        ImagePicker.MediaTypeOptions.Images,
                    allowsMultipleSelection: true,
                    quality: 0.8,
                    exif: false
                });
            } else {
                result = await DocumentPicker.getDocumentAsync({
                    type: fileTypeFilter.length > 0 ? fileTypeFilter.map(type => `${type}*`).join(",") : "*/*",
                    multiple: true,
                    copyToCacheDirectory: true
                });
            }

            if (!result.canceled && result.assets && result.assets.length > 0) {
                setUploading(true);
                const formData = new FormData();

                // Limit the number of files to upload
                const assetsToUpload = result.assets.slice(0, maxFiles);

                for (const asset of assetsToUpload) {
                    const fileUri = Platform.OS === 'ios' ? asset.uri.replace('file://', '') : asset.uri;
                    
                    let fileName: string;
                    let fileType: string;
                    
                    if ('mimeType' in asset) {
                        fileName = (asset as DocumentPickerAsset).name;
                        fileType = (asset as DocumentPickerAsset).mimeType || 'application/octet-stream';
                    } else {
                        const extension = fileUri.split('.').pop() || 'jpg';
                        fileName = `image-${Date.now()}.${extension}`;
                        fileType = `image/${extension}`;
                    }

                    try {
                        const response = await fetch(fileUri);
                        const blob = await response.blob();
                        const file = new File([blob], fileName, { type: fileType });
                        formData.append('files', file);
                    } catch (error) {
                        console.error('Error processing file:', error);
                        toast.error(t("Error processing file"));
                        setUploading(false);
                        return;
                    }
                }

                const response = await api.post('/files/upload', formData, {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'multipart/form-data',
                        'Authorization': `Bearer ${accessToken}`
                    },
                    transformRequest: [(data) => data],
                    onUploadProgress: (progressEvent) => {
                        const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
                        console.log(`Upload progress: ${percentCompleted}%`);
                    }
                });

                if (response.data?.files) {
                    toast.success(t("Files uploaded successfully"));
                    
                    // Invalidate cache for this user
                    const cacheKeysToInvalidate = Array.from(globalFileCache.keys())
                        .filter(key => key.startsWith(`${effectiveUserId}-`));
                    
                    cacheKeysToInvalidate.forEach(key => globalFileCache.delete(key));
                    
                    // Force refresh files
                    await fetchFiles(true);
                }
            }
        } catch (error: any) {
            console.error("Upload error:", error);
            toast.error(error?.response?.data?.message || t("Error uploading files"));
        } finally {
            setUploading(false);
        }
    }, [userId, fileTypeFilter, t, fetchFiles, maxFiles, sessionContext]);

    const deleteFile = useCallback(async (fileId: string) => {
        try {
            await api.delete(`/files/${fileId}`);
            toast.success(t("File deleted successfully"));
            
            // Update all caches that might contain this file
            globalFileCache.forEach((cacheEntry, key) => {
                const updatedFiles = cacheEntry.files.filter(file => file._id !== fileId);
                if (updatedFiles.length !== cacheEntry.files.length) {
                    globalFileCache.set(key, {
                        ...cacheEntry,
                        files: updatedFiles
                    });
                }
            });
            
            // Update local state
            setFiles(prevFiles => prevFiles.filter(file => file._id !== fileId));
        } catch (error: any) {
            console.error("Delete error:", error);
            toast.error(error?.response?.data?.message || t("Error deleting file"));
        }
    }, [t]);

    return {
        files,
        loading,
        uploading,
        fetchFiles,
        uploadFiles,
        deleteFile
    };
}