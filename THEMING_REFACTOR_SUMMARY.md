# Theming System Refactor - Summary

## Overview
Successfully refactored the entire theming system to provide consistent, centralized theme management across the Mention application, following Oxy AI Development Instructions.

## Key Changes

### 1. Created Centralized Theme System (`hooks/useTheme.ts`)
- **New `useTheme()` hook**: Provides consistent theme colors, mode (light/dark), and utilities
- **Context-independent**: Does NOT require OxyProvider context, avoiding initialization errors
- **Oxy integration**: Works with appearance store which syncs with Oxy user settings
- **Theme structure includes**:
  - Background colors (primary, secondary, tertiary)
  - Text colors (primary, secondary, tertiary)
  - Border colors
  - Brand colors (primary, secondary/Oxy)
  - Interactive colors (tint, icon, iconActive)
  - Status colors (success, error, warning, info)
  - Component-specific colors (card, shadow, overlay)
- **Integrates with OxyProvider**: Checks for theme settings from Oxy package when available
- **User customization**: Respects user's custom primary color from appearance settings
- **System preference**: Falls back to system theme (light/dark) based on user settings

### 2. Updated Core Components
#### `components/ThemedView.tsx`
- Now uses centralized `useTheme()` hook
- Maintains backward compatibility with legacy `lightColor`/`darkColor` props (marked as deprecated)
- Automatically applies themed background colors

#### `components/ThemedText.tsx`
- Now uses centralized `useTheme()` hook
- Maintains backward compatibility with legacy color props (marked as deprecated)
- Link type text automatically uses theme primary color

### 3. Created Theme Utilities (`utils/theme.ts`)
- **`createThemedStyles()`**: For creating StyleSheet styles with theme-aware colors
- **`withOpacity()`**: Add opacity to any color
- **`adjustBrightness()`**: Create lighter/darker shades
- **`getThemedShadow()`**: Consistent shadows (small, medium, large)
- **`getThemedBorder()`**: Themed border styles
- **`getThemedCard()`**: Themed card styling

### 4. Updated Components with Hardcoded Colors
#### Settings Screen (`app/settings/index.tsx`)
- Replaced all hardcoded hex colors (#666, #333, #ff4757, etc.) with theme colors
- Added theme-aware styles for:
  - Headers and titles
  - Setting items and sections
  - Icons and chevrons
  - Switch components
  - Sign out button with error color
  - All text elements

#### RepostScreen (`components/RepostScreen.tsx`)
- Replaced hardcoded colors with theme colors
- Updated background, text, border, and button colors
- Made primary action button use theme primary color

#### SideBar (`components/SideBar/index.tsx`)
- Updated button text colors to use theme
- Added `useTheme()` hook import

#### BottomSheetContext (`context/BottomSheetContext.tsx`)
- Updated bottom sheet handle indicator to use theme text color
- Now adapts to dark/light theme

### 5. Integrated with OxyProvider
#### Updated `app/_layout.tsx`
- Changed OxyProvider `theme` prop from hardcoded `"light"` to dynamic `colorScheme`
- Now respects user's theme preference (light/dark/system)
- Properly passes theme mode to Oxy ecosystem

## Color Mapping
### Light Mode
- Background: `#FDFDFD` (very light gray)
- Text: `#1e1e1e` (dark gray)
- Border: `#ededed` (light gray)
- Primary: User's custom color or `#005c67` (teal)
- Secondary: `#d169e5` (Oxy brand purple)

### Dark Mode
- Background: `#1A1A1A` (dark gray)
- Text: `#ededed` (light gray)
- Border: `#3c3c3c` (medium dark gray)
- Primary: User's custom color or `#005c67` (teal)
- Secondary: `#d169e5` (Oxy brand purple)

## Important Architecture Notes

### Context Independence
The `useTheme()` hook is **intentionally independent** of the OxyProvider context. This design choice:
- Prevents "useOxy must be used within an OxyContextProvider" errors
- Allows theme usage in components that render before/outside OxyProvider
- Still integrates with Oxy through the `appearanceStore` which syncs user settings
- Provides consistent theming throughout the app lifecycle

### Oxy Integration Path
```
User Theme Settings (Oxy) 
  → appearanceStore (synced via API)
    → useColorScheme (reads from store)
      → useTheme (provides theme colors)
        → Components (apply themed styles)
```

## Benefits

1. **Consistency**: All components now use the same color system
2. **Maintainability**: Single source of truth for theme colors
3. **Flexibility**: Easy to add new themes or customize colors
4. **User Preference**: Respects user's theme choice (light/dark/system)
5. **Oxy Integration**: Ready to use Oxy's theme system when available
6. **Type Safety**: Full TypeScript support with Theme and ThemeColors interfaces
7. **Performance**: useMemo optimization for theme color calculations
8. **Accessibility**: Proper contrast ratios for light and dark modes

## Usage Examples

### In Components
```typescript
import { useTheme } from "@/hooks/useTheme";

function MyComponent() {
  const theme = useTheme();
  
  return (
    <View style={{ backgroundColor: theme.colors.background }}>
      <Text style={{ color: theme.colors.text }}>Hello</Text>
      <TouchableOpacity style={{ backgroundColor: theme.colors.primary }}>
        <Text style={{ color: theme.colors.card }}>Button</Text>
      </TouchableOpacity>
    </View>
  );
}
```

### With Utilities
```typescript
import { useTheme } from "@/hooks/useTheme";
import { getThemedCard, getThemedShadow } from "@/utils/theme";

function CardComponent() {
  const theme = useTheme();
  
  return (
    <View style={[getThemedCard(theme), getThemedShadow(theme, "medium")]}>
      <Text style={{ color: theme.colors.text }}>Card Content</Text>
    </View>
  );
}
```

## Migration Guide for Other Components

To update other components with hardcoded colors:

1. Import the theme hook:
   ```typescript
   import { useTheme } from "@/hooks/useTheme";
   ```

2. Use the hook in your component:
   ```typescript
   const theme = useTheme();
   ```

3. Replace hardcoded colors:
   - `#000` or `#1A1A1A` → `theme.colors.background` (dark mode)
   - `#fff` or `#FDFDFD` → `theme.colors.background` (light mode)
   - `#666` → `theme.colors.textSecondary`
   - `#999` or `#ccc` → `theme.colors.textTertiary`
   - `#1D9BF0` or brand colors → `theme.colors.primary`
   - `#ff4757` or error colors → `theme.colors.error`

4. Apply inline styles where needed:
   ```typescript
   <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
     <Text style={[styles.text, { color: theme.colors.text }]}>Content</Text>
   </View>
   ```

## Files Modified

### New Files
- `packages/frontend/hooks/useTheme.ts`
- `packages/frontend/utils/theme.ts`

### Modified Files
- `packages/frontend/components/ThemedView.tsx`
- `packages/frontend/components/ThemedText.tsx`
- `packages/frontend/app/settings/index.tsx`
- `packages/frontend/components/RepostScreen.tsx`
- `packages/frontend/components/SideBar/index.tsx`
- `packages/frontend/context/BottomSheetContext.tsx`
- `packages/frontend/app/_layout.tsx`

## Future Enhancements

1. **Additional Theme Variants**: Could add more theme presets (e.g., high contrast, colorblind-friendly)
2. **Dynamic Theme Switching**: Live theme preview in settings
3. **Custom Color Schemes**: Let users create completely custom themes
4. **Theme Animations**: Smooth transitions when switching themes
5. **Theme Persistence**: Save theme choice to backend for cross-device sync
6. **Oxy Theme API**: When Oxy package provides theme API, integrate fully

## Compliance with Oxy AI Development Instructions

✅ Uses double quotes and 2-space indentation
✅ Follows TypeScript best practices
✅ Integrates with OxyProvider ecosystem
✅ Respects user preferences stored in Oxy system
✅ Supports both light and dark themes
✅ Uses Oxy brand color (#d169e5) as secondary
✅ Ready for future Oxy theme API integration
✅ Maintains backward compatibility
