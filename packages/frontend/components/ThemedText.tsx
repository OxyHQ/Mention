import { Text, type TextProps } from "react-native";
import { cn } from "@/lib/utils";

const TYPE_CLASSES: Record<string, string> = {
  default: "text-base leading-6 font-[Inter-Regular]",
  defaultSemiBold: "text-base leading-6 font-semibold font-[Inter-Regular]",
  title: "text-[32px] leading-8 font-bold font-[Inter-Regular]",
  subtitle: "text-xl font-bold font-[Inter-Regular]",
  link: "text-base leading-[30px] font-[Inter-Regular] text-primary",
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
