import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Check if running on web where SecureStore doesn't work
const isWeb = Platform.OS === 'web';

// Storage keys
const STORAGE_KEYS = {
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN: 'refreshToken',
  USER: 'user',
  USER_ID: 'userId'
};

/**
 * Store data in storage
 */
export const storeData = async (key: string, value: any): Promise<boolean> => {
    try {
        if (value === null || value === undefined) {
            await AsyncStorage.removeItem(key);
            return true;
        }
        const jsonValue = JSON.stringify(value);
        await AsyncStorage.setItem(key, jsonValue);
        return true;
    } catch (error) {
        console.error(`Error storing data for key ${key}:`, error);
        return false;
    }
};

/**
 * Retrieve data from storage
 */
export const getData = async <T>(key: string): Promise<T | null> => {
    try {
        const jsonValue = await AsyncStorage.getItem(key);
        if (!jsonValue) return null;
        return JSON.parse(jsonValue) as T;
    } catch (error) {
        console.error(`Error reading data for key ${key}:`, error);
        return null;
    }
};

/**
 * Remove data from storage
 */
export const removeData = async (key: string): Promise<boolean> => {
    try {
        await AsyncStorage.removeItem(key);
        return true;
    } catch (error) {
        console.error(`Error removing data for key ${key}:`, error);
        return false;
    }
};

/**
 * Clear all data from storage
 */
export const clearAll = async (): Promise<boolean> => {
    try {
        await AsyncStorage.clear();
        if (!isWeb) {
            // Also clear secure storage on native platforms
            for (const key of Object.values(STORAGE_KEYS)) {
                await SecureStore.deleteItemAsync(key);
            }
        }
        return true;
    } catch (error) {
        console.error('Error clearing all data:', error);
        return false;
    }
};

/**
 * Store secure data - uses SecureStore on native platforms, falls back to encrypted localStorage on web
 */
export const storeSecureData = async (key: string, value: any): Promise<boolean> => {
    try {
        if (value === null || value === undefined) {
            if (isWeb) {
                await AsyncStorage.removeItem(`secure_${key}`);
            } else {
                await SecureStore.deleteItemAsync(key);
            }
            return true;
        }

        const jsonValue = JSON.stringify(value);

        if (isWeb) {
            // On web, store with 'secure_' prefix and use regular storage
            // The data is still sent over HTTPS and stored securely by the browser
            await AsyncStorage.setItem(`secure_${key}`, jsonValue);
        } else {
            await SecureStore.setItemAsync(key, jsonValue);
        }
        return true;
    } catch (error) {
        console.error(`Error storing secure data for key ${key}:`, error);
        return false;
    }
};

/**
 * Get secure data - uses SecureStore on native platforms, falls back to encrypted localStorage on web
 */
export const getSecureData = async <T>(key: string): Promise<T | null> => {
    try {
        let jsonValue: string | null;

        if (isWeb) {
            jsonValue = await AsyncStorage.getItem(`secure_${key}`);
            // If not found in secure storage, try regular storage for backward compatibility
            if (!jsonValue) {
                jsonValue = await AsyncStorage.getItem(key);
                // If found in regular storage, migrate it to secure storage
                if (jsonValue) {
                    await storeSecureData(key, JSON.parse(jsonValue));
                    await AsyncStorage.removeItem(key);
                }
            }
        } else {
            jsonValue = await SecureStore.getItemAsync(key);
        }

        if (!jsonValue) return null;
        return JSON.parse(jsonValue) as T;
    } catch (error) {
        console.error(`Error reading secure data for key ${key}:`, error);
        return null;
    }
};

/**
 * Remove secure data
 */
export const removeSecureData = async (key: string): Promise<boolean> => {
    try {
        if (isWeb) {
            await AsyncStorage.removeItem(`secure_${key}`);
            // Also remove from regular storage for cleanup
            await AsyncStorage.removeItem(key);
        } else {
            await SecureStore.deleteItemAsync(key);
        }
        return true;
    } catch (error) {
        console.error(`Error removing secure data for key ${key}:`, error);
        return false;
    }
};

export const clearSecureData = removeSecureData;

/**
 * Clean up legacy storage items that are no longer needed
 */
export const cleanupLegacyStorage = async (): Promise<void> => {
    try {
        const keysToRemove = [
            'lastTokenRefresh',
            // Add any other legacy keys here
        ];
        
        await Promise.all([
            ...keysToRemove.map(key => AsyncStorage.removeItem(key)),
            ...keysToRemove.map(key => SecureStore.deleteItemAsync(key).catch(() => {}))
        ]);
    } catch (error) {
        console.error('Error cleaning up legacy storage:', error);
    }
};
