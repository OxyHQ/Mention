import { Text, type TextProps } from "react-native";
import { cn } from "@/lib/utils";

const TYPE_CLASSES: Record<string, string> = {
  default: "text-base leading-6",
  defaultSemiBold: "text-base leading-6 font-semibold",
  title: "text-[32px] leading-8 font-bold",
  subtitle: "text-xl font-bold",
  link: "text-base leading-[30px] text-primary",
};

export type ThemedTextProps = TextProps & {
  className?: string;
  type?: "default" | "title" | "defaultSemiBold" | "subtitle" | "link";
};

export function ThemedText({
  style,
  className,
  type = "default",
  ...rest
}: ThemedTextProps) {
  return (
    <Text
      className={cn("text-foreground", TYPE_CLASSES[type], className)}
      style={style}
      {...rest}
    />
  );
}
