import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';

const storage = new MMKV({ id: 'mention_storage' });

export const storeData = async (key: string, value: any): Promise<boolean> => {
    try {
        if (value === null || value === undefined) {
            storage.delete(key);
            return true;
        }
        const jsonValue = JSON.stringify(value);
        storage.set(key, jsonValue);
        return true;
    } catch (error) {
        console.error(`Error storing data for key ${key}:`, error);
        return false;
    }
};

export const getData = async <T>(key: string): Promise<T | null> => {
    try {
        const jsonValue = storage.getString(key);
        if (jsonValue === undefined || jsonValue === null) return null;
        return JSON.parse(jsonValue) as T;
    } catch (error) {
        console.error(`Error reading data for key ${key}:`, error);
        return null;
    }
};

export const removeData = async (key: string): Promise<boolean> => {
    try {
        storage.delete(key);
        return true;
    } catch (error) {
        console.error(`Error removing data for key ${key}:`, error);
        return false;
    }
};

export const clearAll = async (): Promise<boolean> => {
    try {
        storage.clearAll();
        return true;
    } catch (error) {
        console.error('Error clearing all data:', error);
        return false;
    }
};

export const storeSecureData = async (key: string, value: any): Promise<boolean> => {
    try {
        if (value === null || value === undefined) {
            await SecureStore.deleteItemAsync(key);
            return true;
        }
        const jsonValue = JSON.stringify(value);
        await SecureStore.setItemAsync(key, jsonValue);
        return true;
    } catch (error) {
        console.error(`Error storing secure data for key ${key}:`, error);
        return false;
    }
};

export const getSecureData = async <T>(key: string): Promise<T | null> => {
    try {
        const jsonValue = await SecureStore.getItemAsync(key);
        if (jsonValue === null) return null;
        return JSON.parse(jsonValue) as T;
    } catch (error) {
        console.error(`Error reading secure data for key ${key}:`, error);
        return null;
    }
};

export const removeSecureData = async (key: string): Promise<boolean> => {
    try {
        await SecureStore.deleteItemAsync(key);
        return true;
    } catch (error) {
        console.error(`Error removing secure data for key ${key}:`, error);
        return false;
    }
};
