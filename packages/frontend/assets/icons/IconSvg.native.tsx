import { useCssElement } from 'nativewind';
import Svg, { type SvgProps } from 'react-native-svg';

/**
 * Native root for every icon in `assets/icons/*`.
 *
 * Icons author their paths with `fill="currentColor"` / `stroke="currentColor"`.
 * react-native-svg resolves those `currentColor` brushes from the `color` PROP
 * on the `<Svg>`, propagating it to every descendant shape. React Native has no
 * CSS cascade, and react-native-svg's `Svg` is NOT a NativeWind-interop
 * component, so a `text-*` className on the icon is an inert prop on native —
 * which is why icons rendered the default (black) instead of the theme color.
 *
 * `useCssElement` applies the NativeWind interop explicitly: it resolves the
 * `className`, keeps layout/opacity utilities on `style`, and — via
 * `nativeStyleMapping` — MOVES the resolved text color out of `style` and onto
 * react-native-svg's `color` prop. react-native-svg then resolves every
 * `currentColor` to exactly the theme color the call site asked for (e.g.
 * `text-foreground`, `text-primary`), with no per-icon edits and no hardcoded
 * colors. This mirrors how react-native-css ships its own `ActivityIndicator` /
 * `Button` (`{ target: 'style', nativeStyleMapping: { color: 'color' } }`).
 */
const ICON_STYLE_MAPPING = {
  className: {
    target: 'style',
    nativeStyleMapping: { color: 'color' },
  },
} as const;

export function IconSvg({ children, ...props }: SvgProps) {
  return useCssElement(Svg, { ...props, children }, ICON_STYLE_MAPPING);
}
