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
