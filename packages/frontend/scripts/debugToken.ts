import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

(async () => {
  const asyncToken = await AsyncStorage.getItem('oxy_example_access_token');
  const secureToken = await SecureStore.getItemAsync('oxy_example_access_token');
  console.log('AsyncStorage oxy_example_access_token:', asyncToken);
  console.log('SecureStore oxy_example_access_token:', secureToken);
})();
