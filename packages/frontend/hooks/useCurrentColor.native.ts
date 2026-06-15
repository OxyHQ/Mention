import { useUnstableNativeVariable } from 'nativewind';

/**
 * `react-native-css` ships its public types from the WEB runtime
 * (`runtime.d.ts` → `./web`), where `useUnstableNativeVariable` is typed
 * `() => never`. At runtime on native it is the native implementation
 * (`useNativeVariable(name: string)`), which reads a CSS custom property and
 * returns its resolved value. The package exposes no `react-native` types
 * condition, so tsc can only see the web signature. We re-type the symbol to
 * its real native contract here (a precise typed reference, not `any`).
 */
type UseNativeVariable = (name: string) => string | number | undefined;
const readNativeVariable = useUnstableNativeVariable as unknown as UseNativeVariable;

const COLOR_VARIABLE = '--__rn-css-color';
const FOREGROUND_VARIABLE = '--color-foreground';

/**
 * Resolves the value an SVG icon should use for `currentColor` on native.
 *
 * On web, SVG `fill="currentColor"` / `stroke="currentColor"` inherits the CSS
 * `color` of the nearest ancestor (e.g. a `text-primary` wrapper). React Native
 * has no CSS cascade, so `currentColor` never resolves there and icons stay
 * black regardless of the parent's `text-*` class.
 *
 * react-native-css (the engine behind NativeWind 5) propagates a resolved
 * `color` down the tree as the `--__rn-css-color` native variable and compiles
 * CSS `currentColor` to `var(--__rn-css-color)`. Reading that variable here lets
 * an icon pick up the color set by an ancestor's `text-*` className — matching
 * web's cascade behaviour. When no ancestor sets a text color, fall back to the
 * themed foreground (`--color-foreground`, a global root variable independent of
 * React context), and finally to `currentColor` so an icon rendered outside any
 * theme context (toasts, portals, error boundaries) degrades gracefully instead
 * of crashing. This intentionally does NOT call Bloom's `useTheme()`, which
 * throws when an icon renders outside `<BloomThemeProvider>`.
 */
export function useCurrentColor(): string {
  const inherited = readNativeVariable(COLOR_VARIABLE);
  const foreground = readNativeVariable(FOREGROUND_VARIABLE);
  if (typeof inherited === 'string' && inherited.length > 0) {
    return inherited;
  }
  if (typeof foreground === 'string' && foreground.length > 0) {
    return foreground;
  }
  return 'currentColor';
}
