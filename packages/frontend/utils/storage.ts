import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Generic storage utility for caching data
 */
export class Storage {
  /**
   * Get item from storage
   */
  static async get<T>(key: string): Promise<T | null> {
    try {
      const item = await AsyncStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.warn(`[Storage] Failed to get item: ${key}`, error);
      return null;
    }
  }

  /**
   * Set item in storage
   */
  static async set<T>(key: string, value: T): Promise<boolean> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`[Storage] Failed to set item: ${key}`, error);
      return false;
    }
  }

  /**
   * Remove item from storage
   */
  static async remove(key: string): Promise<boolean> {
    try {
      await AsyncStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`[Storage] Failed to remove item: ${key}`, error);
      return false;
    }
  }
}

/**
 * Get item from storage (wrapper function for backward compatibility)
 */
export async function getData<T>(key: string): Promise<T | null> {
  return Storage.get<T>(key);
}

/**
 * Set item in storage (wrapper function for backward compatibility)
 */
export async function storeData<T>(key: string, value: T): Promise<boolean> {
  return Storage.set<T>(key, value);
}

/**
 * Remove item from storage (wrapper function for backward compatibility)
 */
export async function removeData(key: string): Promise<boolean> {
  return Storage.remove(key);
}
