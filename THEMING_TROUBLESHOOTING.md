# Theming System Troubleshooting

## Common Issues and Solutions

### ❌ Error: "useOxy must be used within an OxyContextProvider"

**Problem**: A component is trying to use `useOxy()` before the OxyProvider is initialized.

**Solution**: The `useTheme()` hook has been designed to be context-independent. It does NOT call `useOxy()` directly. Instead, it reads from the appearance store which syncs with Oxy user settings.

**Check if**:
- You're calling `useOxy()` directly in a component that renders outside OxyProvider
- You're importing an old/cached version of the theme hook

**Fix**:
```typescript
// ❌ Don't call useOxy in components outside OxyProvider
const { user } = useOxy(); // This will error

// ✅ Use useTheme instead for theme-related data
const theme = useTheme(); // This works anywhere
```

### ❌ Theme not updating when user changes settings

**Problem**: Theme colors aren't reflecting user's custom primary color or theme mode.

**Solution**: Ensure the appearance store is loaded:

```typescript
import { useAppearanceStore } from "@/store/appearanceStore";

function MyComponent() {
  const { loadMySettings } = useAppearanceStore();
  const theme = useTheme();
  
  useEffect(() => {
    loadMySettings(); // Load user settings
  }, []);
  
  // Now theme will have custom colors
}
```

### ❌ Colors not changing between light/dark mode

**Problem**: Colors remain the same regardless of theme mode.

**Check**:
1. Is `useColorScheme()` returning the correct mode?
2. Are you using `theme.colors.xxx` or hardcoded colors?
3. Is the appearance store returning the correct theme mode?

**Debug**:
```typescript
const theme = useTheme();
console.log('Theme mode:', theme.mode); // Should be 'light' or 'dark'
console.log('Is dark:', theme.isDark);
console.log('Background color:', theme.colors.background);
```

### ❌ TypeScript errors with theme colors

**Problem**: TypeScript complaining about theme color properties.

**Solution**: Ensure you're importing the correct types:

```typescript
import { useTheme, Theme, ThemeColors } from "@/hooks/useTheme";

// Use Theme type for theme object
const theme: Theme = useTheme();

// Use ThemeColors for colors object
const colors: ThemeColors = theme.colors;
```

### ❌ Theme hook causing re-renders

**Problem**: Components re-rendering too frequently when using `useTheme()`.

**Solution**: The theme hook uses `useMemo` for colors. Only destructure what you need:

```typescript
// ❌ This might cause unnecessary re-renders
function MyComponent() {
  const theme = useTheme();
  // Using entire theme object
}

// ✅ Better - only get what you need
function MyComponent() {
  const { colors, isDark } = useTheme();
  // Only re-renders when colors or isDark changes
}

// ✅ Or use useThemeColor for single colors
import { useThemeColor } from "@/hooks/useTheme";
const textColor = useThemeColor("text");
```

### ❌ Custom primary color not applying

**Problem**: User's custom primary color isn't showing up.

**Check**:
1. Is the custom color saved in appearance settings?
2. Is the appearance store loaded?
3. Are you using `theme.colors.primary`?

**Debug**:
```typescript
const { mySettings } = useAppearanceStore();
console.log('Custom color:', mySettings?.appearance?.primaryColor);

const theme = useTheme();
console.log('Theme primary:', theme.colors.primary);
```

### ❌ Theme not persisting across app restarts

**Problem**: Theme settings reset when app restarts.

**Solution**: This is handled by the appearance store which syncs with the backend. Ensure:
1. User is logged in (settings are user-specific)
2. API calls to save settings are successful
3. Settings are loaded on app start

```typescript
// In root layout or app initialization
useEffect(() => {
  const { loadMySettings } = useAppearanceStore.getState();
  loadMySettings();
}, []);
```

### ❌ Different colors on web vs mobile

**Problem**: Colors look different between platforms.

**Check**:
1. Both platforms using same `useTheme()` hook?
2. No platform-specific color overrides?
3. Both reading from same appearance store?

**Note**: The theme system is platform-agnostic. All platforms should use identical colors.

### ❌ StatusBar color not matching theme

**Problem**: StatusBar (top system bar) doesn't match app theme.

**Solution**: Set StatusBar style based on theme:

```typescript
import { StatusBar } from "expo-status-bar";
import { useTheme } from "@/hooks/useTheme";

function App() {
  const theme = useTheme();
  
  return (
    <>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      {/* Rest of app */}
    </>
  );
}
```

## Performance Tips

### Memoize styled components
```typescript
const styles = useMemo(() => ({
  container: {
    backgroundColor: theme.colors.background,
    padding: 16,
  },
}), [theme.colors.background]);
```

### Use theme utilities for complex styles
```typescript
import { getThemedCard, getThemedShadow } from "@/utils/theme";

// ✅ Computed once and memoized
const cardStyle = useMemo(() => 
  getThemedCard(theme), 
  [theme]
);
```

### Don't inline theme objects in render
```typescript
// ❌ Creates new object every render
<View style={{ backgroundColor: theme.colors.background }}>

// ✅ Memoized or use StyleSheet
const styles = StyleSheet.create({ container: {} });
<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
```

## Testing Theme

### Test both modes
```typescript
// Switch to dark mode
await updateMySettings({ 
  appearance: { themeMode: 'dark' } 
});

// Switch to light mode
await updateMySettings({ 
  appearance: { themeMode: 'light' } 
});

// Use system
await updateMySettings({ 
  appearance: { themeMode: 'system' } 
});
```

### Test custom colors
```typescript
await updateMySettings({ 
  appearance: { 
    themeMode: 'dark',
    primaryColor: '#FF6B6B' 
  } 
});
```

## Need Help?

If you're still having issues:

1. Check `/home/nate/Mention/THEMING_REFACTOR_SUMMARY.md` for detailed documentation
2. Review `/home/nate/Mention/THEME_QUICK_REFERENCE.md` for usage examples
3. Look at existing themed components like `app/settings/index.tsx` for patterns
4. Ensure all dependencies are up to date
5. Clear cache and rebuild: `npm run clean && npm run start --reset-cache`

## Quick Checklist

When adding theme to a new component:

- [ ] Import `useTheme` from `@/hooks/useTheme`
- [ ] Call `const theme = useTheme()` in component
- [ ] Replace hardcoded colors with `theme.colors.xxx`
- [ ] Test in both light and dark modes
- [ ] Verify on both web and mobile
- [ ] Check that changes persist across restarts
- [ ] Ensure no `useOxy()` calls outside OxyProvider

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│   User Settings (Oxy Backend)          │
└────────────────┬────────────────────────┘
                 │ API Sync
                 ▼
┌─────────────────────────────────────────┐
│   appearanceStore                       │
│   - mySettings                          │
│   - appearance.themeMode                │
│   - appearance.primaryColor             │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│   useColorScheme()                      │
│   - Reads themeMode from store          │
│   - Returns 'light' | 'dark'            │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│   useTheme()                            │
│   - No OxyProvider dependency           │
│   - Computes theme colors               │
│   - Returns Theme object                │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│   Components                            │
│   - Apply theme.colors.xxx              │
│   - Respond to theme changes            │
└─────────────────────────────────────────┘
```

This architecture ensures theming works throughout the app lifecycle without context dependencies.
