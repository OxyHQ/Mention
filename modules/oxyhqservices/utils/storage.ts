import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Check if running on web where SecureStore doesn't work
const isWeb = Platform.OS === 'web';

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
        if (jsonValue === null) return null;
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
        return true;
    } catch (error) {
        console.error('Error clearing all data:', error);
        return false;
    }
};

/**
 * Store secure data - falls back to regular storage on web
 */
export const storeSecureData = async (key: string, value: any): Promise<boolean> => {
    try {
        if (value === null || value === undefined) {
            if (isWeb) {
                // On web, use AsyncStorage with a prefix for "secure" data
                await AsyncStorage.removeItem(`secure_${key}`);
            } else {
                await SecureStore.deleteItemAsync(key);
            }
            return true;
        }
        
        const jsonValue = JSON.stringify(value);
        
        if (isWeb) {
            // On web, use AsyncStorage with a prefix for "secure" data
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
 * Get secure data - falls back to regular storage on web
 */
export const getSecureData = async <T>(key: string): Promise<T | null> => {
    try {
        let jsonValue;
        
        if (isWeb) {
            // On web, use AsyncStorage with a prefix for "secure" data
            jsonValue = await AsyncStorage.getItem(`secure_${key}`);
        } else {
            jsonValue = await SecureStore.getItemAsync(key);
        }
        
        if (jsonValue === null) return null;
        return JSON.parse(jsonValue) as T;
    } catch (error) {
        console.error(`Error reading secure data for key ${key}:`, error);
        return null;
    }
};

/**
 * Remove secure data - falls back to regular storage on web
 */
export const removeSecureData = async (key: string): Promise<boolean> => {
    try {
        if (isWeb) {
            // On web, use AsyncStorage with a prefix for "secure" data
            await AsyncStorage.removeItem(`secure_${key}`);
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
        await AsyncStorage.removeItem('lastTokenRefresh');
    } catch (error) {
        console.error('Error cleaning up legacy storage:', error);
    }
};
