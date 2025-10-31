# Performance Optimizations - Theme System

## Problem
The app was experiencing excessive re-renders and poor performance due to inefficient Zustand store subscriptions.

## Root Cause
When components used `useAppearanceStore()` without selectors, they subscribed to **the entire store**. This meant every component re-rendered whenever ANY part of the store changed, including:
- `loading` state changes
- `error` updates  
- `byUserId` record updates
- `mySettings` changes

Since the appearance store is used by `useColorScheme` → `useTheme` → hundreds of components, a single store update triggered a cascade of re-renders across the entire app.

## Solution: Zustand Selectors

Changed from subscribing to the entire store:
```typescript
// ❌ BAD - Subscribes to entire store, re-renders on any change
const { mySettings } = useAppearanceStore();
```

To using selectors to subscribe only to specific values:
```typescript
// ✅ GOOD - Only re-renders when mySettings changes
const mySettings = useAppearanceStore((state) => state.mySettings);
```

## Files Updated

### 1. `hooks/useColorScheme.ts`
- Changed from `const { mySettings } = useAppearanceStore()` 
- To `const mySettings = useAppearanceStore((state) => state.mySettings)`
- Now only re-renders when `mySettings` changes, not on loading/error updates

### 2. `hooks/useColorScheme.web.ts`
- Applied same selector optimization
- Web-specific hydration logic remains unchanged

### 3. `hooks/useTheme.ts`
- Changed from `const { mySettings } = useAppearanceStore()`
- To `const mySettings = useAppearanceStore((state) => state.mySettings)`
- Since this hook is used throughout the app, this optimization has the biggest impact

### 4. `app/_layout.tsx`
- Changed from `const { loadMySettings } = useAppearanceStore()`
- To `const loadMySettings = useAppearanceStore((state) => state.loadMySettings)`
- Prevents root layout re-renders on store updates

### 5. `app/settings/appearance.tsx`
- Split destructuring into individual selectors:
  ```typescript
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loading = useAppearanceStore((state) => state.loading);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  ```
- Each selector only triggers re-renders for its specific value

### 6. `components/ProfileScreen.tsx`
- Changed from `const { byUserId, loadForUser } = useAppearanceStore()`
- To individual selectors for `byUserId` and `loadForUser`

### 7. `store/appearanceStore.ts`
- Added documentation comment about using selectors
- No code changes, but improved documentation

## Performance Impact

### Before
- Every appearance store update → Re-render ALL components using the store
- `useTheme()` called in ~100+ components → 100+ unnecessary re-renders per store update
- Cascading re-renders throughout component tree
- Poor scrolling performance, laggy UI interactions

### After
- Store updates only trigger re-renders in components that use the changed value
- `loading` state changes only affect components that display loading indicators
- `mySettings` changes only affect components that use theme/appearance data
- Functions (`loadMySettings`, `updateMySettings`) never cause re-renders (stable references)
- Dramatically reduced re-render count

## Best Practices Going Forward

### ✅ DO:
```typescript
// Subscribe to specific values
const mySettings = useAppearanceStore((state) => state.mySettings);

// Subscribe to specific functions
const loadSettings = useAppearanceStore((state) => state.loadMySettings);

// Subscribe to nested values if you only need part of an object
const themeMode = useAppearanceStore((state) => state.mySettings?.appearance?.themeMode);
```

### ❌ DON'T:
```typescript
// Subscribe to entire store
const { mySettings, loading, error } = useAppearanceStore();

// This causes re-renders for ALL store changes
const store = useAppearanceStore();
```

## Additional Optimizations Applied

1. **Memoization in useTheme**: The `colors` object is already memoized with `useMemo([isDark, customPrimaryColor])`
2. **QueryClient memoization**: Already memoized in `_layout.tsx` with `useMemo([], [])`
3. **Stable function references**: Zustand store functions are stable and don't change, preventing unnecessary callback re-runs

## Testing

After these changes, you should notice:
- Smoother scrolling
- Faster UI interactions
- No lag when changing theme mode
- Reduced CPU/memory usage
- Better battery life on mobile

## Further Optimizations (Future)

If performance issues persist, consider:
1. `React.memo()` on expensive leaf components
2. `useCallback()` for event handlers passed as props
3. Virtual list rendering for long lists (react-window/flashlist)
4. Code splitting for route-based lazy loading
5. Profiling with React DevTools to identify remaining bottlenecks
