import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';

const storage = new MMKV({ id: 'mention_storage' });

(async () => {
  const asyncToken = storage.getString('oxy_example_access_token');
  const secureToken = await SecureStore.getItemAsync('oxy_example_access_token');
  console.log('MMKV oxy_example_access_token:', asyncToken);
  console.log('SecureStore oxy_example_access_token:', secureToken);
})();
