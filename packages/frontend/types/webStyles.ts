import type { ViewStyle, TextStyle } from 'react-native';

/**
 * react-native-web accepts a handful of CSS values/properties that are valid on
 * the web but absent from React Native's native style unions (e.g.
 * `position: 'sticky'`/`'fixed'`, `cursor`, `userSelect`, `outlineStyle`,
 * `resize`, `backdropFilter`). Authoring those through these extended style
 * types — then bridging to the RN type at the consumption point — keeps the
 * web-only intent explicit and type-checked instead of using an `as any` cast.
 *
 * The single source of the pattern previously duplicated in SideBar, RightBar,
 * and insights.
 */
type WebOnlyStyleProps = {
  cursor?: 'pointer' | 'default' | 'text' | 'grab' | 'grabbing' | 'not-allowed' | 'auto';
  userSelect?: 'none' | 'auto' | 'text' | 'all';
  outlineStyle?: 'none' | 'solid' | 'dotted' | 'dashed';
  outlineWidth?: number;
  resize?: 'none' | 'both' | 'horizontal' | 'vertical';
  backdropFilter?: string;
  transition?: string;
};

/** Keys `WebOnlyStyleProps` redefines — omit them from the base before intersecting. */
type WebOnlyStyleKeys = keyof WebOnlyStyleProps;

/** Viewport-relative length values valid in CSS but absent from RN's number-only sizes. */
type WebLength = `${number}vh` | `${number}vw` | `calc(${string})`;

/** ViewStyle plus web-only CSS values/properties react-native-web understands. */
export type WebViewStyle = Omit<ViewStyle, 'position' | 'height' | 'width' | WebOnlyStyleKeys> &
  WebOnlyStyleProps & {
    position?: ViewStyle['position'] | 'sticky' | 'fixed';
    height?: ViewStyle['height'] | WebLength;
    width?: ViewStyle['width'] | WebLength;
  };

/** TextStyle plus web-only CSS values/properties react-native-web understands. */
export type WebTextStyle = Omit<TextStyle, 'position' | WebOnlyStyleKeys> &
  WebOnlyStyleProps & {
    position?: TextStyle['position'] | 'sticky' | 'fixed';
  };

/** Bridge a `WebViewStyle` back to RN's `ViewStyle` at the consumption point. */
export const asViewStyle = (style: WebViewStyle): ViewStyle => style as unknown as ViewStyle;

/** Bridge a `WebTextStyle` back to RN's `TextStyle` at the consumption point. */
export const asTextStyle = (style: WebTextStyle): TextStyle => style as unknown as TextStyle;
