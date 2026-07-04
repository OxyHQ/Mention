import { LogBox } from 'react-native';

/**
 * Suppress the harmless dev-only React Native Web "Unexpected text node" warning.
 * The React Compiler (Hermes) can emit stray punctuation string children in
 * compiled JSX (e.g. a literal ".") which trips a console.error in RNW's View.
 * `LogBox.ignoreLogs` hides the overlay but the console.error still fires, so we
 * also patch console.error itself. Call once at module scope.
 */
export function suppressRnwTextNodeWarning() {
  LogBox.ignoreLogs(['Unexpected text node: . A text node cannot be a child of a <View>.']);

  if (__DEV__) {
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (
        typeof args[0] === 'string' &&
        args[0].startsWith('Unexpected text node: ') &&
        args[0].includes('A text node cannot be a child of a <View>')
      ) {
        return; // swallow harmless React Compiler + RNW noise
      }
      origConsoleError.apply(console, args);
    };
  }
}
