import {
Select,
SelectContent,
SelectIcon,
SelectItem,
SelectItemIndicator,
SelectItemText,
SelectTrigger,
SelectValue,
} from "@oxy.so/bloom/select";
import { StyleSheet } from "react-native";

/** The compact select composition used by Bloom's SettingsGeneralPage template. */
export function SettingsSelect<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        const item = items.find((item) => item.value === value);
        if (item) onChange(item.value);
      }}
    >
      <SelectTrigger label={label} fieldStyle={styles.trigger}>
        <SelectValue>
          {(value) => {
            const key =
              typeof value === "object" && value !== null && "value" in value
                ? value.value
                : value;
            return (
              items.find((item) => item.value === key)?.label ?? String(key)
            );
          }}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={items}
        valueExtractor={(item) => item.value}
        renderItem={(item) => (
          <SelectItem value={item.value} label={item.label}>
            <SelectItemIndicator />
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}

// Padding, never a height: a fixed `h-8` left 15.5dp for a 20dp line on
// Android and cut the value in half (#1126). The text sets the height.
const styles = StyleSheet.create({
  trigger: { gap: 4, paddingLeft: 8, paddingRight: 8, paddingTop: 5, paddingBottom: 5 },
});
