# Theme System Quick Reference

## Import the Theme Hook

```typescript
import { useTheme } from "@/hooks/useTheme";
```

## Use in Components

```typescript
function MyComponent() {
  const theme = useTheme();
  
  // Access theme properties
  const isDark = theme.isDark;          // boolean
  const isLight = theme.isLight;        // boolean
  const mode = theme.mode;              // "light" | "dark"
  const colors = theme.colors;          // ThemeColors object
}
```

## Available Theme Colors

### Backgrounds
```typescript
theme.colors.background          // Main background
theme.colors.backgroundSecondary // Secondary surfaces
theme.colors.backgroundTertiary  // Tertiary surfaces
theme.colors.card               // Card/modal backgrounds
```

### Text
```typescript
theme.colors.text               // Primary text
theme.colors.textSecondary      // Secondary text (labels, descriptions)
theme.colors.textTertiary       // Tertiary text (placeholders, disabled)
```

### Borders
```typescript
theme.colors.border             // Standard borders
theme.colors.borderLight        // Light borders/dividers
```

### Brand Colors
```typescript
theme.colors.primary            // Primary brand color (user customizable)
theme.colors.primaryLight       // Light variant
theme.colors.primaryDark        // Dark variant
theme.colors.secondary          // Oxy brand color (#d169e5)
```

### Interactive
```typescript
theme.colors.tint               // Tint color (same as primary)
theme.colors.icon               // Default icon color
theme.colors.iconActive         // Active icon color
```

### Status
```typescript
theme.colors.success            // Success states (#10B981)
theme.colors.error              // Error states (#EF4444)
theme.colors.warning            // Warning states (#F59E0B)
theme.colors.info               // Info states (#3B82F6)
```

### Special
```typescript
theme.colors.shadow             // Shadow color
theme.colors.overlay            // Modal/overlay backgrounds
```

## Common Patterns

### Basic Styled Component
```typescript
<View style={{ backgroundColor: theme.colors.background }}>
  <Text style={{ color: theme.colors.text }}>Hello World</Text>
</View>
```

### Combining with StyleSheet
```typescript
const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 8,
  },
});

// In component
<View style={[styles.container, { backgroundColor: theme.colors.card }]}>
  <Text style={{ color: theme.colors.text }}>Content</Text>
</View>
```

### Icons
```typescript
<Ionicons 
  name="home" 
  size={24} 
  color={theme.colors.icon} 
/>

// Active state
<Ionicons 
  name="home" 
  size={24} 
  color={theme.colors.iconActive} 
/>
```

### Buttons
```typescript
// Primary button
<TouchableOpacity style={{
  backgroundColor: theme.colors.primary,
  padding: 12,
  borderRadius: 8,
}}>
  <Text style={{ color: theme.colors.card }}>
    Primary Button
  </Text>
</TouchableOpacity>

// Destructive button
<TouchableOpacity style={{
  backgroundColor: theme.colors.error,
  padding: 12,
  borderRadius: 8,
}}>
  <Text style={{ color: theme.colors.card }}>
    Delete
  </Text>
</TouchableOpacity>
```

### Borders
```typescript
<View style={{
  borderWidth: 1,
  borderColor: theme.colors.border,
  borderRadius: 8,
}}>
  {/* Content */}
</View>
```

### Switch Components
```typescript
<Switch
  value={enabled}
  onValueChange={setEnabled}
  trackColor={{ 
    false: theme.colors.backgroundTertiary, 
    true: theme.colors.primary 
  }}
  thumbColor={theme.colors.card}
  ios_backgroundColor={theme.colors.backgroundTertiary}
/>
```

### Text Input
```typescript
<TextInput
  style={{
    backgroundColor: theme.colors.card,
    color: theme.colors.text,
    borderColor: theme.colors.border,
    borderWidth: 1,
  }}
  placeholderTextColor={theme.colors.textTertiary}
  placeholder="Enter text..."
/>
```

## Theme Utilities

### Shadows
```typescript
import { getThemedShadow } from "@/utils/theme";

<View style={[styles.card, getThemedShadow(theme, "medium")]}>
  {/* Content */}
</View>
```

### Borders
```typescript
import { getThemedBorder } from "@/utils/theme";

<View style={[styles.container, getThemedBorder(theme, 1)]}>
  {/* Content */}
</View>
```

### Cards
```typescript
import { getThemedCard } from "@/utils/theme";

<View style={getThemedCard(theme)}>
  {/* Content */}
</View>
```

### Opacity
```typescript
import { withOpacity } from "@/utils/theme";

<View style={{
  backgroundColor: withOpacity(theme.colors.primary, 0.1)
}}>
  {/* Semi-transparent background */}
</View>
```

### Brightness Adjustment
```typescript
import { adjustBrightness } from "@/utils/theme";

<View style={{
  backgroundColor: adjustBrightness(theme.colors.primary, 20) // Lighter
}}>
  {/* Content */}
</View>
```

## Migration Checklist

When updating an old component:

- [ ] Import `useTheme` hook
- [ ] Add `const theme = useTheme();` to component
- [ ] Replace `#000`, `#fff`, etc. with `theme.colors.background`
- [ ] Replace `#666`, etc. with `theme.colors.textSecondary`
- [ ] Replace `#ccc`, `#999` with `theme.colors.textTertiary`
- [ ] Replace brand colors with `theme.colors.primary`
- [ ] Replace error colors with `theme.colors.error`
- [ ] Update Switch `trackColor` and `thumbColor`
- [ ] Update TextInput `placeholderTextColor`
- [ ] Update icon colors
- [ ] Test in both light and dark modes

## ThemedView and ThemedText

These components automatically use theme colors:

```typescript
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";

<ThemedView style={styles.container}>
  <ThemedText type="title">Title</ThemedText>
  <ThemedText type="default">Body text</ThemedText>
  <ThemedText type="link">Link text</ThemedText>
</ThemedView>
```

## Don't Do This ❌

```typescript
// Hardcoded colors
<View style={{ backgroundColor: "#1A1A1A" }}>
  <Text style={{ color: "#666" }}>Text</Text>
</View>

// Wrong import
import { Colors } from "@/constants/Colors";
```

## Do This Instead ✅

```typescript
// Theme-aware colors
const theme = useTheme();

<View style={{ backgroundColor: theme.colors.background }}>
  <Text style={{ color: theme.colors.textSecondary }}>Text</Text>
</View>
```

## Theme Mode Checking

```typescript
const theme = useTheme();

if (theme.isDark) {
  // Dark mode specific logic
} else {
  // Light mode specific logic
}
```

## Getting a Single Color

```typescript
import { useThemeColor } from "@/hooks/useTheme";

function MyComponent() {
  const textColor = useThemeColor("text");
  const bgColor = useThemeColor("background");
  
  return (
    <View style={{ backgroundColor: bgColor }}>
      <Text style={{ color: textColor }}>Hello</Text>
    </View>
  );
}
```

## Questions?

Refer to:
- [THEMING_REFACTOR_SUMMARY.md](./THEMING_REFACTOR_SUMMARY.md) for detailed documentation
- `packages/frontend/hooks/useTheme.ts` for implementation
- `packages/frontend/utils/theme.ts` for utilities
