import { View, type ViewProps } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export type ThemedViewProps = ViewProps & {
  /**
   * Override background color. Use theme.colors.xxx from useTheme() hook instead when possible
   * @deprecated - Prefer using useTheme hook and theme.colors
   */
  lightColor?: string;
  /**
   * Override background color. Use theme.colors.xxx from useTheme() hook instead when possible
   * @deprecated - Prefer using useTheme hook and theme.colors
   */
  darkColor?: string;
};

export function ThemedView({ style, lightColor, darkColor, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  // Support legacy lightColor/darkColor props but prefer theme colors
  const backgroundColor = lightColor || darkColor
    ? (theme.isDark ? darkColor : lightColor) || theme.colors.background
    : theme.colors.background;

  return <View style={[{ backgroundColor }, style]} {...otherProps} />;
}
