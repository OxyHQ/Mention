import Svg, { type SvgProps } from 'react-native-svg';

/**
 * Web root for every icon in `assets/icons/*`.
 *
 * Icons author their paths with `fill="currentColor"` / `stroke="currentColor"`.
 * On web the CSS cascade is intact: the `className` (e.g. `text-foreground`)
 * lands on the rendered DOM `<svg>` as a real class, sets its CSS `color`, and
 * `currentColor` inherits for free. So we forward every prop — including
 * `className` — straight to react-native-svg (its web renderer passes the class
 * through to the DOM element) and let the cascade do the work. No JS color
 * resolution is needed or wanted here.
 */
export function IconSvg({ children, ...props }: SvgProps) {
  return <Svg {...props}>{children}</Svg>;
}
