// On web, react-native-safe-area-context's SafeAreaView already honours
// `className` (react-native-web + NativeWind handle it natively), so no interop
// wrapper is needed — re-export the original.
export { SafeAreaView } from 'react-native-safe-area-context';
