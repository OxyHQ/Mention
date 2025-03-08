import { useState, useCallback, useRef, useEffect, useContext, useMemo } from 'react';
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

// Error handling utility
const handleFileError = (error: any, t: any, context: string): void => {
  console.error(`[Files][${context}] Error:`, error);
  
  let errorMessage = t("An error occurred");
  
  if (error?.response?.data?.message) {
    errorMessage = error.response.data.message;
  } else if (error?.message) {
    errorMessage = error.message;
  }
  
  toast.error(errorMessage);
};

export function useFiles({ fileTypeFilter = [], maxFiles = 5, userId }: UseFilesOptions = {}) {
    const [files, setFiles] = useState<FileType[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    
    // Use a ref to track the abort controller for fetch operations
    const abortControllerRef = useRef<AbortController | null>(null);
    
    // Use a ref to track the current user ID for cleanup
    const currentUserIdRef = useRef<string | undefined>(userId);
    
    // Memoize the effective user ID
    const effectiveUserId = useMemo(() => 
      userId || sessionContext?.getCurrentUserId() || undefined, 
      [userId, sessionContext]
    );
    
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

    // Generate cache key based on user ID and file type filter
    const getCacheKey = useCallback((uid: string) => 
      `${uid}-${fileTypeFilter.join(',')}`, 
      [fileTypeFilter]
    );

    const fetchFiles = useCallback(async (forceRefresh = false) => {
        if (!effectiveUserId) {
            console.warn('[Files] No user ID available');
            setFiles([]);
            setLoading(false);
            setError("User not authenticated");
            return;
        }

        try {
            setError(null);
            const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
            const refreshToken = await getSecureData<string>(STORAGE_KEYS.REFRESH_TOKEN);
            
            if (!accessToken || !refreshToken) {
                console.warn('[Files] Missing auth tokens');
                setFiles([]);
                setLoading(false);
                setError("Authentication required");
                return;
            }

            // Check cache first
            const cacheKey = getCacheKey(effectiveUserId);
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
                    setError("Session expired");
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
            
            // Sort files by upload date (newest first)
            fetchedFiles.sort((a: FileType, b: FileType) => {
                const dateA = a.uploadDate || '';
                const dateB = b.uploadDate || '';
                return new Date(dateB).getTime() - new Date(dateA).getTime();
            });
            
            globalFileCache.set(cacheKey, {
                files: fetchedFiles,
                timestamp: now,
                userId: effectiveUserId
            });
            
            if (currentUserIdRef.current === userId) {
                setFiles(fetchedFiles);
                setError(null);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[Files] Fetch aborted');
                return;
            }
            
            handleFileError(error, t, 'fetchFiles');
            setFiles([]);
            setError(error?.response?.data?.message || t("Error fetching files"));
        } finally {
            if (currentUserIdRef.current === userId) {
                setLoading(false);
            }
        }
    }, [effectiveUserId, fileTypeFilter, t, getCacheKey, userId]);

    const uploadFiles = useCallback(async () => {
        if (!effectiveUserId) {
            toast.error(t("User not authenticated"));
            setError("User not authenticated");
            return;
        }

        try {
            setError(null);
            const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
            if (!accessToken) {
                toast.error(t("Authentication required"));
                setError("Authentication required");
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
                        setError("Error processing file");
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
                    const cacheKey = getCacheKey(effectiveUserId);
                    globalFileCache.delete(cacheKey);
                    
                    // Refresh files list
                    await fetchFiles(true);
                    setError(null);
                }
            }
        } catch (error) {
            handleFileError(error, t, 'uploadFiles');
            setError(error?.response?.data?.message || t("Error uploading files"));
        } finally {
            setUploading(false);
        }
    }, [effectiveUserId, fileTypeFilter, maxFiles, t, fetchFiles, getCacheKey]);

    const deleteFile = useCallback(async (fileId: string) => {
        if (!fileId) {
            toast.error(t("Invalid file ID"));
            return;
        }

        try {
            setError(null);
            const response = await api.delete(`/files/${fileId}`);
            
            if (response.data?.success) {
                toast.success(t("File deleted successfully"));
                
                // Update local state
                setFiles(prevFiles => prevFiles.filter(file => file._id !== fileId));
                
                // Invalidate cache for this user
                if (effectiveUserId) {
                    const cacheKey = getCacheKey(effectiveUserId);
                    globalFileCache.delete(cacheKey);
                }
            }
        } catch (error) {
            handleFileError(error, t, 'deleteFile');
            setError(error?.response?.data?.message || t("Error deleting file"));
        }
    }, [effectiveUserId, t, getCacheKey]);

    // Load files on mount and when dependencies change
    useEffect(() => {
        if (effectiveUserId) {
            fetchFiles();
        }
    }, [effectiveUserId, fetchFiles]);

    return {
        files,
        loading,
        uploading,
        error,
        fetchFiles,
        uploadFiles,
        deleteFile
    };
}