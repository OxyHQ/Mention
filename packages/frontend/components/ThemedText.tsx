import { StyleSheet, Text, type TextProps } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { FONT_FAMILIES } from "@/styles/typography";

export type ThemedTextProps = TextProps & {
  /**
   * Override text color. Use theme.colors.xxx from useTheme() hook instead when possible
   * @deprecated - Prefer using useTheme hook and theme.colors
   */
  lightColor?: string;
  /**
   * Override text color. Use theme.colors.xxx from useTheme() hook instead when possible
   * @deprecated - Prefer using useTheme hook and theme.colors
   */
  darkColor?: string;
  type?: "default" | "title" | "defaultSemiBold" | "subtitle" | "link";
};

export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = "default",
  ...rest
}: ThemedTextProps) {
  const theme = useTheme();

  // Support legacy lightColor/darkColor props but prefer theme colors
  const color = lightColor || darkColor
    ? (theme.isDark ? darkColor : lightColor) || theme.colors.text
    : theme.colors.text;

  return (
    <Text
      style={[
        { color },
        type === "default" ? styles.default : undefined,
        type === "title" ? styles.title : undefined,
        type === "defaultSemiBold" ? styles.defaultSemiBold : undefined,
        type === "subtitle" ? styles.subtitle : undefined,
        type === "link" ? [styles.link, { color: theme.colors.primary }] : undefined,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  default: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: FONT_FAMILIES.primary,
  },
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    fontFamily: FONT_FAMILIES.primary,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
    fontFamily: FONT_FAMILIES.primary,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: "bold",
    fontFamily: FONT_FAMILIES.primary,
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    fontFamily: FONT_FAMILIES.primary,
    // Color is applied via theme.colors.primary in component
  },
});
