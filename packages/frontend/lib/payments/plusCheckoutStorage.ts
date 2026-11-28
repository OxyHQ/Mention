import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { checkoutStorageKey, type PlusOfferBinding } from './plusCheckout';

const pending = new Map<string, Promise<string>>();
async function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (Platform.OS !== 'web') return run();
  // AsyncStorage's browser get/set is not atomic across tabs. Never overwrite
  // another tab's recovery key if this host cannot coordinate the operation.
  if (!globalThis.navigator?.locks) throw new Error('Checkout coordination unavailable');
  return globalThis.navigator.locks.request(key, run);
}
/** Persist before POST; interruption or dismissal keeps the same operation. */
export function getPlusCheckoutKey(accountId: string, offer: PlusOfferBinding): Promise<string> {
  const key = checkoutStorageKey(accountId, offer);
  const previous = pending.get(key);
  if (previous) return previous;
  const operation = locked(key, async () => {
    const saved = await AsyncStorage.getItem(key);
    if (saved) return saved;
    const created = randomUUID();
    await AsyncStorage.setItem(key, created);
    return created;
  });
  pending.set(key, operation);
  void operation.finally(() => pending.delete(key)).catch(() => {});
  return operation;
}
export function clearPlusCheckoutKey(
  accountId: string,
  offer: PlusOfferBinding,
  completedKey: string,
): Promise<void> {
  const key = checkoutStorageKey(accountId, offer);
  return locked(key, async () => {
    // A delayed terminal response must not erase a newer operation's key.
    if ((await AsyncStorage.getItem(key)) === completedKey) await AsyncStorage.removeItem(key);
  });
}
