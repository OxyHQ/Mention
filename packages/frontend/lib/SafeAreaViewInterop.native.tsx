import { SafeAreaView as RawSafeAreaView } from 'react-native-safe-area-context';
import { styled } from 'nativewind';

/**
 * NativeWind 5 / react-native-css 3 do NOT apply `className` to
 * `react-native-safe-area-context`'s `SafeAreaView`: the global-className
 * polyfill swaps that module to `react-native-css/components/react-native-safe-area-context`,
 * which only overrides `SafeAreaProvider` and re-exports `SafeAreaView` RAW
 * (`export * from "react-native-safe-area-context"`). The raw component has no
 * className→style interop, so `<SafeAreaView className="flex-1">` is silently
 * dropped and the screen root collapses to zero height.
 *
 * `styled()` wraps the component in react-native-css's className interop the
 * same way `react-native-css/components/View` is wrapped, so `className` (incl.
 * layout utilities like `flex-1`) applies again.
 */
export const SafeAreaView = styled(RawSafeAreaView, { className: 'style' });
