# Live Space as Persistent Bottom Sheet

## Goal
The live space should open inside a bottom sheet that persists while the user navigates the app. The user can collapse it to a mini player bar and keep listening. Uses sonner for toasts instead of Alert.

---

## Architecture: LiveSpaceProvider

A global context (`LiveSpaceContext`) that:
- Manages the active space connection (socket + audio) at the provider level
- Renders a **non-modal `BottomSheet`** (from @gorhom/bottom-sheet) with snap points `[MINI_BAR_HEIGHT, '100%']`
- When no active space → sheet is closed (index: -1)
- When expanded → sheet at index 1 (100%)
- When minimized → sheet at index 0 (~80px mini bar)
- The hooks (`useSpaceConnection`, `useSpaceAudio`, `useSpaceUsers`) live inside the sheet content, which stays mounted at any snap point
- Down arrow collapses from full → mini bar
- End button calls API + leaves + closes sheet
- Uses `toast` from sonner for all notifications (not Alert.alert)

### Mini Bar (collapsed state)
Shows: Space title (truncated) | Mic toggle | Leave button
Tapping the bar expands to full view.

---

## Files to Create

### 1. `packages/frontend/context/LiveSpaceContext.tsx`
- **Context API:**
  ```ts
  interface LiveSpaceContextProps {
    activeSpaceId: string | null;
    joinLiveSpace: (spaceId: string) => void;
    leaveLiveSpace: () => void;
  }
  ```
- **Provider renders:**
  - A `BottomSheet` (NOT BottomSheetModal) with `ref`, snap points `[80, '100%']`, `index={-1}`, `enablePanDownToClose={false}`
  - Inside the sheet: `<LiveSpaceSheetContent>` when `activeSpaceId` is set
  - `joinLiveSpace(id)` → sets activeSpaceId, snaps to index 1 (full screen)
  - `leaveLiveSpace()` → calls leave(), clears activeSpaceId, closes sheet (index -1)

### 2. `packages/frontend/components/spaces/LiveSpaceSheet.tsx`
- Extracted from current `live/[id].tsx`
- Props: `spaceId: string`, `onCollapse: () => void`, `onLeave: () => void`
- Contains ALL the hooks: `useSpaceConnection`, `useSpaceAudio`, `useSpaceUsers`
- Uses `BottomSheetScrollView` (from @gorhom/bottom-sheet) instead of regular `ScrollView`
- Uses `toast` from sonner instead of `Alert.alert`
- Sub-components: RoleBadge, SpeakerTile, ListenerAvatar, ConnectedSpeakerTile, ConnectedListenerAvatar, ConnectedRequestRow (moved from live/[id].tsx)

### 3. `packages/frontend/components/spaces/MiniSpaceBar.tsx`
- Compact bar (80px height): space title + LIVE badge + mic toggle + leave button
- Tapping the bar expands the sheet (calls `expandSheet()`)
- Reads from `useSpaceConnection` results passed as props

---

## Files to Modify

### 4. `packages/frontend/components/providers/AppProviders.tsx`
- Add `LiveSpaceProvider` inside the provider chain (after `BottomSheetModalProvider`, before `MenuProvider`)
- Import from `@/context/LiveSpaceContext`

### 5. `packages/frontend/app/(app)/spaces/index.tsx`
- Import `useLiveSpace` from `@/context/LiveSpaceContext`
- Replace `router.push('/spaces/live/${space._id}')` → `joinLiveSpace(space._id)`

### 6. `packages/frontend/app/(app)/spaces/[id].tsx`
- Import `useLiveSpace` from `@/context/LiveSpaceContext`
- Replace `router.push('/spaces/live/${id}')` → `joinLiveSpace(id)`
- Replace `Alert.alert('Error', ...)` → `toast.error(...)`
- Import `toast` from `sonner`

### 7. `packages/frontend/app/(app)/spaces/create.tsx`
- Import `useLiveSpace`
- After create+start: `joinLiveSpace(space._id)` then `router.replace('/spaces')`
- Replace Alert → toast

### 8. `packages/frontend/app/(app)/spaces/live/[id].tsx`
- Convert to a thin redirect: reads `id` param, calls `joinLiveSpace(id)`, navigates back
- This preserves deep linking support

---

## Sonner Toast Replacements
- `Alert.alert('Error', 'Failed to end space')` → `toast.error('Failed to end space')`
- `Alert.alert('Space Ended', '...')` → `toast('Space ended', { description: 'The host ended this space' })`
- `Alert.alert('Error', 'Failed to start space')` → `toast.error('Failed to start space')`
- Import pattern: `import { toast } from 'sonner'`

## Key Existing Infrastructure (reuse)
- `@gorhom/bottom-sheet` v5.2.6 — already installed, `BottomSheetModalProvider` in AppProviders
- `BottomSheetContext` pattern at `context/BottomSheetContext.tsx` — reference for how to structure the provider
- `sonner` / `sonner-native` — already installed, `Toaster` in AppProviders, import from `sonner`
- `useSpaceConnection` at `hooks/useSpaceConnection.ts` — socket connection hook
- `useSpaceAudio` at `hooks/useSpaceAudio.ts` — audio recording/playback hook
- `useSpaceUsers`, `getDisplayName`, `getAvatarUrl` at `hooks/useSpaceUsers.ts` — profile resolution

## Implementation Order
1. Create `LiveSpaceSheet.tsx` — extract UI from `live/[id].tsx`
2. Create `MiniSpaceBar.tsx` — compact player bar
3. Create `LiveSpaceContext.tsx` — provider with BottomSheet + state management
4. Add `LiveSpaceProvider` to `AppProviders.tsx`
5. Update `index.tsx`, `[id].tsx`, `create.tsx` to use `joinLiveSpace()`
6. Convert `live/[id].tsx` to redirect
7. Replace all `Alert.alert` with sonner `toast`

## Verification
- Create a space, start it, join → bottom sheet should open full screen
- Tap down arrow → collapses to mini bar at bottom, audio keeps playing
- Navigate to other screens (feed, profile) → mini bar persists, audio continues
- Tap mini bar → expands back to full screen
- Tap End → space ends, sheet closes, toast notification shown
- Tap Leave → disconnects, sheet closes
- Deep link to `/spaces/live/[id]` → redirects and opens sheet
