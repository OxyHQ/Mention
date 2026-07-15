# Mention Edit Profile Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Mention its own "Edit Profile" screen (`/edit-profile`) that consolidates banner, profile style, accent color, and pinned song/podcast — currently scattered across `settings/appearance.tsx`, `settings/profile-customization.tsx`, and inline on the public profile — separate from the shared Oxy `ManageAccount` sheet.

**Architecture:** One new route (`app/(app)/edit-profile.tsx`) composing three new, self-contained section components (`BannerSection`, `ProfileStyleSection`, `PinnedMediaSection`) plus the existing `ColorSwatchPicker`/`useAppColorSave`, all reading/writing the same `useAppearanceStore` the source screens already use. No backend/store/API changes.

**Tech Stack:** Expo Router, React Native, NativeWind (className), `@oxyhq/bloom` (theme, icons, settings-list, item), `react-i18next`, Zustand (`useAppearanceStore`).

## Global Constraints

- Package manager is `bun` — never `npm`/`npx` (use `bunx`).
- This corner of the frontend has **zero existing component-test coverage** (confirmed: only `hooks/__tests__/usePostLanguage.test.tsx` exists in the whole package, no `@testing-library/react-native` usage anywhere touching Profile/Settings). Do **not** introduce a new Jest/RTL component-test pattern here — that would be an unrequested, unilateral restructure of this codebase's testing culture. Each task's verification gate is `bun run typecheck` (`node ./scripts/typecheck.mjs`) + `bun run lint` (`expo lint`), run from `packages/frontend`. The final task is a manual verification pass in a real running app, per this project's standing rule that UI changes must be checked in a browser before being called done.
- Never use `as any`, `@ts-ignore`, `@ts-expect-error`, `!` non-null assertions, or `console.log`.
- i18n: this repo ships `locales/en.json`, `locales/es.json`, `locales/it.json` as **flat key-value** maps (e.g. `"profile.editProfile": "Edit Profile"`), not nested objects. Every new user-facing string needs a real entry in all three files — don't rely solely on inline `t('key', 'default')` fallback for anything new.
- No re-exports, no barrel files, no compatibility shims. Import directly from the owning file.
- Commit after each task with the repo's normal commit style (no `--no-verify`).

---

### Task 1: `BannerSection` component

**Files:**
- Create: `packages/frontend/components/Profile/EditProfile/BannerSection.tsx`

**Interfaces:**
- Consumes: `useAuth()` from `@oxyhq/services` (`showBottomSheet`, `oxyServices`), `useAppearanceStore` from `@/store/appearanceStore` (`mySettings`, `updateMySettings`), `useTheme` from `@oxyhq/bloom/theme`, `Icon` from `@/lib/icons`, `useTranslation` from `react-i18next`.
- Produces: `export const BannerSection: React.FC` — a self-contained, no-props section (reads/writes the store directly, exactly like the screen it's extracted from). Later tasks render `<BannerSection />` with no props.

This is a straight extraction of the "Profile header" section from `app/(app)/settings/appearance.tsx` (current lines ~40-46, 117-137, 283-329), unchanged in behavior.

- [ ] **Step 1: Confirm the extraction source still matches (no drift since this plan was written)**

Run: `grep -n "openHeaderPicker\|removeHeaderImage\|headerImageId\|Profile header" packages/frontend/app/\(app\)/settings/appearance.tsx`
Expected: hits at the same logic described above. If the file has changed shape, stop and re-read it before continuing — do not guess.

- [ ] **Step 2: Create the component**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon } from '@/lib/icons';
import { useAppearanceStore } from '@/store/appearanceStore';

/**
 * Profile banner picker/preview — extracted from the old
 * `settings/appearance.tsx` "Profile header" section, unchanged in behavior.
 * Self-contained: reads/writes `useAppearanceStore` directly.
 */
export const BannerSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { showBottomSheet, oxyServices } = useAuth();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [headerImageId, setHeaderImageId] = useState<string>(mySettings?.profileHeaderImage ?? '');

  useEffect(() => {
    if (mySettings?.profileHeaderImage !== undefined) {
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings?.profileHeaderImage]);

  const openHeaderPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: { id: string; contentType?: string }) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          setHeaderImageId(file.id);
          await updateMySettings({ profileHeaderImage: file.id });
        },
      },
    });
  }, [showBottomSheet, updateMySettings]);

  const removeHeaderImage = useCallback(async () => {
    setHeaderImageId('');
    await updateMySettings({ profileHeaderImage: '' });
  }, [updateMySettings]);

  return (
    <View className="px-5 py-4 gap-3">
      <View className="flex-row items-center gap-3">
        <Icon name="image-outline" size={22} color={colors.text} />
        <Text className="text-[16px] text-foreground">
          {t('settings.profileHeader', 'Profile header')}
        </Text>
      </View>

      {headerImageId ? (
        <View className="rounded-xl overflow-hidden border border-border relative">
          <Image
            source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }}
            className="w-full h-32 bg-muted"
            resizeMode="cover"
          />
          <View className="absolute bottom-2 right-2 flex-row gap-1.5">
            <Pressable
              className="w-8 h-8 rounded-full items-center justify-center bg-black/60"
              onPress={openHeaderPicker}
            >
              <Icon name="camera-outline" size={16} color="#FFFFFF" />
            </Pressable>
            <Pressable
              className="w-8 h-8 rounded-full items-center justify-center bg-red-500/80"
              onPress={removeHeaderImage}
            >
              <Icon name="trash-outline" size={16} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          className="rounded-xl border-[1.5px] border-dashed border-border bg-secondary py-5 items-center gap-1.5"
          onPress={openHeaderPicker}
        >
          <View className="w-10 h-10 rounded-full items-center justify-center bg-muted">
            <Icon name="image-outline" size={20} color={colors.textSecondary} />
          </View>
          <Text className="text-sm font-semibold text-foreground">
            {t('settings.uploadHeader', 'Upload header image')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
          </Text>
        </Pressable>
      )}
    </View>
  );
};
```

- [ ] **Step 3: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0. `BannerSection.tsx` is not imported anywhere yet, so this only validates its own types/imports resolve.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/components/Profile/EditProfile/BannerSection.tsx
git commit -m "feat(frontend): add BannerSection for the new Edit Profile screen"
```

---

### Task 2: `ProfileStyleSection` component

**Files:**
- Create: `packages/frontend/components/Profile/EditProfile/ProfileStyleSection.tsx`

**Interfaces:**
- Consumes: `useAppearanceStore` (`mySettings`, `updateMySettings`), `useTheme`, `Icon`, `useTranslation`, `logger` from `@/lib/logger`.
- Produces: `export const ProfileStyleSection: React.FC` — self-contained, no props.

Straight extraction of `app/(app)/settings/profile-customization.tsx`'s "Profile Style" section (the whole file minus its `Header`/`ThemedView`/auth-gate shell and minus its "Profile Color" section, which becomes its own reused `ColorSwatchPicker` block directly in the new screen in Task 4 — not duplicated here).

- [ ] **Step 1: Confirm the extraction source still matches**

Run: `grep -n "StyleOption\|handleStyleSelect\|currentStyle" packages/frontend/app/\(app\)/settings/profile-customization.tsx`
Expected: hits matching the logic below. Stop and re-read if the file has changed shape.

- [ ] **Step 2: Create the component**

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon } from '@/lib/icons';
import { useAppearanceStore } from '@/store/appearanceStore';
import { logger } from '@/lib/logger';

type ProfileStyle = 'default' | 'minimalist';
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface StyleOption {
  id: ProfileStyle;
  name: string;
  description: string;
  icon: IoniconName;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
}

/**
 * Profile layout picker (default vs. minimalist) — extracted from the old
 * `settings/profile-customization.tsx`, unchanged in behavior. Self-contained:
 * reads/writes `useAppearanceStore` directly.
 */
export const ProfileStyleSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [coverPhotoEnabled, setCoverPhotoEnabled] = useState<boolean>(true);
  const [minimalistMode, setMinimalistMode] = useState<boolean>(false);

  const styleOptions: StyleOption[] = useMemo(() => [
    {
      id: 'default' as ProfileStyle,
      name: t('settings.profileCustomization.styleDefault'),
      description: t('settings.profileCustomization.styleDefaultDesc'),
      icon: 'image-outline',
      coverPhotoEnabled: true,
      minimalistMode: false,
    },
    {
      id: 'minimalist' as ProfileStyle,
      name: t('settings.profileCustomization.styleMinimalist'),
      description: t('settings.profileCustomization.styleMinimalistDesc'),
      icon: 'remove-outline',
      coverPhotoEnabled: false,
      minimalistMode: true,
    },
  ], [t]);

  const currentStyle: ProfileStyle = useMemo(() => {
    if (minimalistMode && !coverPhotoEnabled) {
      return 'minimalist';
    }
    return 'default';
  }, [minimalistMode, coverPhotoEnabled]);

  useEffect(() => {
    if (mySettings) {
      setCoverPhotoEnabled(mySettings.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings.profileCustomization?.minimalistMode ?? false);
    }
  }, [mySettings]);

  const handleStyleSelect = useCallback(async (style: StyleOption) => {
    setCoverPhotoEnabled(style.coverPhotoEnabled);
    setMinimalistMode(style.minimalistMode);

    try {
      await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: style.coverPhotoEnabled,
          minimalistMode: style.minimalistMode,
        },
      });
    } catch (error) {
      logger.error('Error updating profile customization', { error });
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    }
  }, [updateMySettings, mySettings]);

  return (
    <View className="px-5 py-3 gap-3">
      <View className="flex-row items-center gap-3">
        <Icon name="layers-outline" size={22} color={colors.text} />
        <Text className="text-[16px] text-foreground">
          {t('settings.profileCustomization.profileStyle')}
        </Text>
      </View>
      <View className="flex-row gap-3">
        {styleOptions.map((style) => {
          const isSelected = currentStyle === style.id;
          return (
            <TouchableOpacity
              key={style.id}
              className="flex-1 rounded-xl overflow-hidden relative"
              style={{
                minWidth: '47%',
                backgroundColor: colors.card,
                borderColor: isSelected ? colors.primary : colors.border,
                borderWidth: isSelected ? 2 : 1,
              }}
              onPress={() => handleStyleSelect(style)}
              activeOpacity={0.7}
            >
              <View className="w-full overflow-hidden">
                {style.coverPhotoEnabled ? (
                  <View className="w-full h-[60px]" style={{ backgroundColor: colors.primary + '20' }} />
                ) : (
                  <View className="w-full h-0" />
                )}

                <View className="px-2 pb-3 pt-1" style={{ backgroundColor: colors.background }}>
                  <View
                    className="w-10 h-10 rounded-full self-start"
                    style={{
                      backgroundColor: colors.backgroundSecondary,
                      borderWidth: 2,
                      borderColor: colors.background,
                      marginTop: style.minimalistMode ? 8 : -20,
                    }}
                  />
                  <View className="mt-2">
                    <View
                      className="h-3 w-4/5 rounded-md"
                      style={{
                        backgroundColor: colors.backgroundSecondary,
                        marginTop: style.minimalistMode ? 8 : 12,
                      }}
                    />
                    <View
                      className="h-2.5 w-3/5 rounded-md mt-1"
                      style={{ backgroundColor: colors.backgroundSecondary }}
                    />
                  </View>
                  <View
                    className="h-2 w-full rounded mt-2"
                    style={{ backgroundColor: colors.backgroundSecondary }}
                  />
                  <View
                    className="h-2 w-3/5 rounded mt-1"
                    style={{ backgroundColor: colors.backgroundSecondary }}
                  />
                </View>
              </View>

              <View className="p-3">
                <View className="flex-row items-center gap-1.5 mb-1">
                  <Icon
                    name={style.icon}
                    size={18}
                    color={isSelected ? colors.primary : colors.textSecondary}
                  />
                  <Text
                    className="text-sm font-semibold"
                    style={{ color: isSelected ? colors.primary : colors.text }}
                  >
                    {style.name}
                  </Text>
                </View>
                <Text className="text-xs leading-4 text-muted-foreground">
                  {style.description}
                </Text>
              </View>

              {isSelected && (
                <View
                  className="absolute top-2 right-2 w-6 h-6 rounded-full items-center justify-center"
                  style={{ backgroundColor: colors.primary }}
                >
                  <Icon name="checkmark" size={14} color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};
```

Note: the original screen showed a header-level saving spinner shared across its style and color sections. That shared spinner is dropped in this consolidation — each section already gives immediate optimistic feedback (the card selection updates instantly) and rolls back silently on failure, which was the behavior that actually mattered; the spinner was cosmetic. Do not reintroduce cross-section saving-state plumbing for this — YAGNI.

- [ ] **Step 3: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/components/Profile/EditProfile/ProfileStyleSection.tsx
git commit -m "feat(frontend): add ProfileStyleSection for the new Edit Profile screen"
```

---

### Task 3: `PinnedMediaSection` component

**Files:**
- Create: `packages/frontend/components/Profile/EditProfile/PinnedMediaSection.tsx`

**Interfaces:**
- Consumes: `useAppearanceStore` (`mySettings.profileMedia: ProfileMedia | null`), `BottomSheetContext` from `@/context/BottomSheetContext` (`setBottomSheetContent`, `openBottomSheet`), `MediaPickerSheet` from `./MediaPickerSheet` (`components/Profile/MediaPickerSheet.tsx` — unchanged, reused as-is), `ProfileSong` from `./ProfileSong`, `PodcastCard` from `@/components/Podcast/PodcastCard`, `useTheme`, icons `MusicNote_Stroke2_Corner0_Rounded`/`PlusLarge_Stroke2_Corner0_Rounded` from `@oxyhq/bloom/icons`, `useTranslation`.
- Produces: `export const PinnedMediaSection: React.FC` — self-contained, no props.

This is new UI, not a pure extraction: unlike `ProfileMedia.tsx` (which hides the "add" affordance for non-owners and, after Task 6, hides it entirely when empty), this section is **always** in edit mode — it's only ever rendered on the Edit Profile screen, which only the owner can reach.

- [ ] **Step 1: Confirm `MediaPickerSheet`'s props and `ProfileMedia`/`ProfileSong`/`PodcastCard` signatures haven't drifted**

Run: `grep -n "interface MediaPickerSheetProps\|interface ProfileSongProps\|PodcastCardProps" packages/frontend/components/Profile/MediaPickerSheet.tsx packages/frontend/components/Profile/ProfileSong.tsx packages/frontend/components/Podcast/PodcastCard.tsx`
Expected: `MediaPickerSheetProps { currentMedia: ProfileMedia | null; onClose: () => void }`. Read `ProfileSong.tsx`'s and `PodcastCard.tsx`'s prop interfaces before writing Step 2 if they differ from the calls in `components/Profile/ProfileMedia.tsx:67-81` (reproduced below) — that file is the reference for exact prop names.

- [ ] **Step 2: Create the component**

```tsx
import React, { useCallback, useContext } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { PlusLarge_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { useAppearanceStore } from '@/store/appearanceStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ProfileSong } from '../ProfileSong';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { MediaPickerSheet } from '../MediaPickerSheet';

/**
 * Pinned song/podcast editor for the Edit Profile screen. Unlike
 * `ProfileMedia` (the read-only public-profile display, which hides entirely
 * when nothing is pinned), this section always shows either the current pick
 * or an "Add" affordance — it only ever renders on a screen the owner alone
 * can reach.
 */
export const PinnedMediaSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const media = useAppearanceStore((state) => state.mySettings?.profileMedia ?? null);
  const bottomSheet = useContext(BottomSheetContext);

  const openPicker = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <MediaPickerSheet
        currentMedia={media}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, media]);

  if (!media) {
    return (
      <View className="px-5 py-3">
        <Pressable
          className="flex-row items-center gap-2"
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={t('profile.media.add')}
        >
          <View
            className="rounded-full bg-secondary items-center justify-center"
            style={{ width: 32, height: 32 }}
          >
            <PlusLarge_Stroke2_Corner0_Rounded size="sm" fill={colors.primary} />
          </View>
          <Text className="text-primary text-[15px]">{t('profile.media.add')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="px-5 py-3">
      {media.type === 'song' ? (
        <ProfileSong song={media} isOwnProfile onEdit={openPicker} />
      ) : (
        <PodcastCard
          variant="full"
          title={media.title}
          author={media.author}
          artworkUrl={media.artworkUrl}
          showUrl={media.showUrl}
          isOwnProfile
          onEdit={openPicker}
        />
      )}
    </View>
  );
};
```

- [ ] **Step 3: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0. If `ProfileSong`/`PodcastCard` prop names differ from Step 1's findings, fix the call sites here to match — don't change `ProfileSong`/`PodcastCard` themselves.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/components/Profile/EditProfile/PinnedMediaSection.tsx
git commit -m "feat(frontend): add PinnedMediaSection for the new Edit Profile screen"
```

---

### Task 4: `app/(app)/edit-profile.tsx` screen + i18n keys

**Files:**
- Create: `packages/frontend/app/(app)/edit-profile.tsx`
- Modify: `packages/frontend/locales/en.json`, `packages/frontend/locales/es.json`, `packages/frontend/locales/it.json`

**Interfaces:**
- Consumes: `BannerSection` (Task 1), `ProfileStyleSection` (Task 2), `PinnedMediaSection` (Task 3), `ColorSwatchPicker` from `@/components/settings/ColorSwatchPicker`, `useAppColorSave` from `@/hooks/useAppColorSave`, `useAuth`/`OxyAuthPrompt` from `@oxyhq/services`, `Header`/`IconButton`/`BackArrowIcon`/`ThemedView`/`useSafeBack` (same imports as `profile-customization.tsx`), `SettingsListGroup`/`SettingsListItem`/`SettingsListDivider` from `@oxyhq/bloom/settings-list`, `RowIcon` from `@/components/settings/RowIcon`.
- Produces: default-exported route component at `/edit-profile`. Later tasks (5) navigate to this route by string path — no typed params needed (it's a static route, no `[id]`).

- [ ] **Step 1: Add the new i18n keys**

The screen title reuses the existing `profile.editProfile` key. One new key set is needed for the "Oxy account" footer row. Add to all three locale files (flat key format, alphabetically near the existing `settings.editProfile.*`/`settings.preferences.*` neighborhood — exact insertion point doesn't matter, these are flat maps).

`packages/frontend/locales/en.json` — add:
```json
  "settings.editProfile.oxyAccount": "Oxy account",
  "settings.editProfile.oxyAccountDesc": "Name, bio, avatar, and security",
```

`packages/frontend/locales/es.json` — add:
```json
  "settings.editProfile.oxyAccount": "Cuenta de Oxy",
  "settings.editProfile.oxyAccountDesc": "Nombre, biografía, avatar y seguridad",
```

`packages/frontend/locales/it.json` — add:
```json
  "settings.editProfile.oxyAccount": "Account Oxy",
  "settings.editProfile.oxyAccountDesc": "Nome, biografia, avatar e sicurezza",
```

- [ ] **Step 2: Verify the JSON is still valid after the edit**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/frontend/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('packages/frontend/locales/es.json','utf8')); JSON.parse(require('fs').readFileSync('packages/frontend/locales/it.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Create the screen**

```tsx
import React, { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { useBloomTheme, PREMIUM_COLOR_NAMES, type AppColorName } from '@oxyhq/bloom/theme';
import { SettingsListDivider, SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { RowIcon } from '@/components/settings/RowIcon';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { ProfileStyleSection } from '@/components/Profile/EditProfile/ProfileStyleSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated, showBottomSheet, user: authUser } = useAuth();
  const { colorPreset: appColor } = useBloomTheme();
  const { saveColor } = useAppColorSave();

  const normalizedUsername = authUser?.username?.toLowerCase();
  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;
  const isOxyUser = normalizedUsername === 'oxy';
  const isFaircoinUser = normalizedUsername === 'faircoin';

  // Reproduces `appearance.tsx`'s premium-color-unlock logic verbatim: full
  // premium palette for premium users, else only the colors tied to a
  // username-gated preset (@oxy unlocks "oxy", @faircoin unlocks "faircoin").
  const unlockedPremiumColors = useMemo<readonly AppColorName[] | undefined>(() => {
    if (isPremium) return PREMIUM_COLOR_NAMES;
    const unlocked: AppColorName[] = [];
    if (isOxyUser) unlocked.push('oxy');
    if (isFaircoinUser) unlocked.push('faircoin');
    return unlocked.length > 0 ? unlocked : undefined;
  }, [isPremium, isOxyUser, isFaircoinUser]);

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('profile.editProfile'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <OxyAuthPrompt
          label={t('settings.profileCustomization.signInRequired', { defaultValue: 'Sign in to customize your profile' })}
          description={t('settings.profileCustomization.signInRequiredDesc', { defaultValue: 'Choose your profile layout and accent color.' })}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('profile.editProfile'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="py-4"
        showsVerticalScrollIndicator={false}
      >
        <BannerSection />
        <SettingsListDivider />
        <ProfileStyleSection />
        <SettingsListDivider />
        <ColorSwatchPicker value={appColor} onChange={saveColor} extraColors={unlockedPremiumColors} />
        <SettingsListDivider />
        <PinnedMediaSection />
        <SettingsListDivider />
        <SettingsListGroup>
          <SettingsListItem
            icon={<RowIcon name="person-circle-outline" />}
            title={t('settings.editProfile.oxyAccount')}
            description={t('settings.editProfile.oxyAccountDesc')}
            onPress={() => showBottomSheet?.('ManageAccount')}
          />
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/app/\(app\)/edit-profile.tsx packages/frontend/locales/en.json packages/frontend/locales/es.json packages/frontend/locales/it.json
git commit -m "feat(frontend): add the consolidated Mention Edit Profile screen"
```

---

### Task 5: Point "Editar perfil" at the new screen

**Files:**
- Modify: `packages/frontend/components/Profile/ProfileHeader.tsx:121` and `:303`

**Interfaces:**
- Consumes: `router` from `expo-router` (already imported at the top of this file, line 3).
- Produces: no change to this file's exports/props — internal `onPress` behavior only.

- [ ] **Step 1: Change `ProfileHeaderDefault`'s button**

In `ProfileHeaderDefault` (around line 119-126), change:
```tsx
            <TouchableOpacity
              className="border border-border bg-background rounded-full px-6 py-2"
              onPress={() => showBottomSheet?.('ManageAccount')}
              accessibilityRole="button"
              accessibilityLabel={t('profile.editProfile')}
            >
```
to:
```tsx
            <TouchableOpacity
              className="border border-border bg-background rounded-full px-6 py-2"
              onPress={() => router.push('/edit-profile')}
              accessibilityRole="button"
              accessibilityLabel={t('profile.editProfile')}
            >
```

- [ ] **Step 2: Change `ProfileActions`'s button**

In `ProfileActions` (around line 301-308), change:
```tsx
      <TouchableOpacity
        className="border border-border bg-background rounded-full px-6 py-2"
        onPress={() => showBottomSheet?.('ManageAccount')}
        accessibilityRole="button"
        accessibilityLabel={t('profile.editProfile')}
      >
```
to:
```tsx
      <TouchableOpacity
        className="border border-border bg-background rounded-full px-6 py-2"
        onPress={() => router.push('/edit-profile')}
        accessibilityRole="button"
        accessibilityLabel={t('profile.editProfile')}
      >
```

- [ ] **Step 3: Check for now-unused `showBottomSheet` prop usage**

Run: `grep -n "showBottomSheet" packages/frontend/components/Profile/ProfileHeader.tsx`
Both call sites should no longer reference `showBottomSheet?.('ManageAccount')`. `ProfileActions` still receives `showBottomSheet` as a prop (per its type signature, `ShowBottomSheetFn`) — check whether it's used anywhere else in that component after this change; if not, remove the now-unused `showBottomSheet` prop from `ProfileActions`'s destructuring **and** from its call site(s) (`grep -rn "<ProfileActions" packages/frontend`) and from `ProfileHeaderDefaultProps`/the relevant type in `./types` if it becomes fully unused there too — but only if truly unused everywhere; don't remove a prop still read by other logic in the same component (e.g. it may still be threaded through for a future use elsewhere in this render tree — verify by reading the full component, not just this diff).

- [ ] **Step 4: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/components/Profile/ProfileHeader.tsx
git commit -m "feat(frontend): Editar perfil opens the new Mention Edit Profile screen"
```

---

### Task 6: Remove the owner-empty branch from `ProfileMedia`

**Files:**
- Modify: `packages/frontend/components/Profile/ProfileMedia.tsx`

**Interfaces:**
- Consumes: unchanged.
- Produces: unchanged public shape (`ProfileMediaProps { media, isOwnProfile }`), but the `!media && isOwnProfile` render branch is removed — `ProfileMedia` now returns `null` whenever `media` is falsy, for every viewer including the owner. Task 3's `PinnedMediaSection` is what now gives the owner an "add" affordance, on the Edit Profile screen only.

- [ ] **Step 1: Edit the component**

Change:
```tsx
  if (!media) {
    // No media: owners get an "Add song or podcast" entry; other viewers see nothing.
    if (!isOwnProfile) {
      return null;
    }
    return (
      <Pressable
        className="flex-row items-center gap-2 mb-3"
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.add')}
      >
        <View
          className="rounded-full bg-secondary items-center justify-center"
          style={{ width: 32, height: 32 }}
        >
          <PlusLarge_Stroke2_Corner0_Rounded size="sm" fill={colors.primary} />
        </View>
        <Text className="text-primary text-[15px]">{t('profile.media.add')}</Text>
      </Pressable>
    );
  }
```
to:
```tsx
  if (!media) {
    // Nothing pinned: management now lives on the Edit Profile screen
    // (`PinnedMediaSection`), not inline on the public profile.
    return null;
  }
```

- [ ] **Step 2: Remove now-unused imports and the `isOwnProfile`/`openPicker` wiring if dead**

Run: `grep -n "isOwnProfile\|openPicker\|PlusLarge_Stroke2_Corner0_Rounded\|useTheme\|useTranslation\|BottomSheetContext" packages/frontend/components/Profile/ProfileMedia.tsx`

`isOwnProfile` is still used by the `song`/`podcast` render branches (passed to `ProfileSong`/`PodcastCard` as `isOwnProfile={isOwnProfile}` — those still show an edit affordance on the pinned-media card itself when the viewer is the owner, unchanged). `openPicker` is still used by those same branches' `onEdit={openPicker}` — do **not** remove it, editing an *existing* pinned song/podcast from the public profile card is unchanged behavior, only the *empty-state add prompt* moved. `PlusLarge_Stroke2_Corner0_Rounded` and `useTheme`'s `colors.primary` usage, however, were only used by the removed branch — if `colors` has no other use in this file after the edit, remove the `useTheme` import and call; remove the `PlusLarge_Stroke2_Corner0_Rounded` import regardless (confirm via the grep above before deleting each one — don't remove an import still referenced elsewhere in the file).

- [ ] **Step 3: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0. An unused-import lint error here means Step 2 was incomplete — fix it, don't suppress it.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/components/Profile/ProfileMedia.tsx
git commit -m "fix(frontend): public profile no longer shows the inline add-media prompt"
```

---

### Task 7: Trim `settings/appearance.tsx` to personal display preferences only

**Files:**
- Modify: `packages/frontend/app/(app)/settings/appearance.tsx`

**Interfaces:**
- Consumes: unchanged for what remains (theme mode, post-text-length, read-more action, collapse-long-bio).
- Produces: this screen no longer reads/writes `profileHeaderImage` or the accent-color preset. `saveSettings`'s payload shrinks accordingly.

- [ ] **Step 1: Remove the banner-related state, handlers, and JSX**

Delete: the `headerImageId`/`setHeaderImageId` state and its `useEffect` (current lines ~44, 48-52), `openHeaderPicker`/`removeHeaderImage` (current lines ~117-137), the `Icon name="image-outline"` "Profile header" `View` block (current lines ~283-329, ending right before the closing `</ScrollView>`), the now-unused `Image`/`Pressable` imports **if** nothing else in this file uses them (check first — `Pressable` may still be used elsewhere; grep before removing).

- [ ] **Step 2: Remove the accent-color section**

Delete: the `Icon name="color-palette"` "Accent color" `View` block (current lines ~269-279) and its `SettingsListDivider` pairing. Remove `onColorChange`/`saveColor`/`colorSaving`/`useAppColorSave` and `ColorSwatchPicker`/`unlockedPremiumColors`/`isOxyUser`/`isFaircoinUser`/`isPremium`/`authUserRecord`/`PREMIUM_COLOR_NAMES` — all of this logic moved to Task 4's screen verbatim, so it must be fully removed here, not duplicated. Also remove `oxyServices` from the `useAuth()` destructure if it becomes unused (it was only consumed by the banner's `getFileDownloadUrl` call, which is also removed).

- [ ] **Step 3: Update `saveSettings`'s signature and payload**

Change:
```tsx
  const saveSettings = useCallback(async (updates: {
    themeMode?: ThemeMode;
    primaryColor?: string;
    headerImageId?: string;
    postTextExpand?: PostTextExpand;
    postReadMoreAction?: PostReadMoreAction;
    collapseLongBio?: boolean;
  }) => {
    setSettingsSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const color = updates.primaryColor ?? preset.hex;
    const header = updates.headerImageId ?? headerImageId;
    const expand = updates.postTextExpand ?? postTextExpand;
    const readMoreAction = updates.postReadMoreAction ?? postReadMoreAction;
    const collapseBio = updates.collapseLongBio ?? collapseLongBio;
    await updateMySettings({
      appearance: {
        themeMode: mode,
        primaryColor: color || undefined,
        postTextExpand: expand,
        postReadMoreAction: readMoreAction,
        collapseLongBio: collapseBio,
      },
      profileHeaderImage: header || null,
    });
    setSettingsSaving(false);
  }, [themeMode, preset.hex, headerImageId, postTextExpand, postReadMoreAction, collapseLongBio, updateMySettings]);
```
to:
```tsx
  const saveSettings = useCallback(async (updates: {
    themeMode?: ThemeMode;
    postTextExpand?: PostTextExpand;
    postReadMoreAction?: PostReadMoreAction;
    collapseLongBio?: boolean;
  }) => {
    setSettingsSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const expand = updates.postTextExpand ?? postTextExpand;
    const readMoreAction = updates.postReadMoreAction ?? postReadMoreAction;
    const collapseBio = updates.collapseLongBio ?? collapseLongBio;
    await updateMySettings({
      appearance: {
        themeMode: mode,
        postTextExpand: expand,
        postReadMoreAction: readMoreAction,
        collapseLongBio: collapseBio,
      },
    });
    setSettingsSaving(false);
  }, [themeMode, postTextExpand, postReadMoreAction, collapseLongBio, updateMySettings]);
```

Note: `primaryColor` is deliberately dropped from this screen's payload — the accent color is now written exclusively via `useAppColorSave`'s `saveColor` on the Edit Profile screen (Task 4), which already calls `updateMySettings` itself; this screen must not also write a stale/undefined `primaryColor` on every unrelated save (e.g. toggling dark mode would otherwise silently overwrite the user's chosen color with `undefined` under the old code's `color || undefined` fallback once `preset`/`appColor` are removed from this file — removing the field entirely, not defaulting it, is the correct fix here, not incidental).

- [ ] **Step 4: Remove now-dead top-of-component values**

Run: `grep -n "preset\b\|appColor\b\|PREMIUM_COLOR_NAMES\|AppColorName" packages/frontend/app/\(app\)/settings/appearance.tsx`
Remove `const preset = APP_COLOR_PRESETS[appColor];`, the `appColor`/`setMode` destructure's `colorPreset: appColor` part (keep `mode: bloomMode`/`setMode` if still used by theme-mode logic), and the now-unused `APP_COLOR_PRESETS`/`PREMIUM_COLOR_NAMES`/`AppColorName` imports from `@oxyhq/bloom/theme` — keep only what theme-mode logic still needs (`useTheme`, `useBloomTheme`, and whatever `ThemeMode`-related exports remain in use).

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0. Fix any unused-import/unused-variable errors surfaced — they're the signal that Steps 1-4 left something behind.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/app/\(app\)/settings/appearance.tsx
git commit -m "refactor(frontend): appearance settings keep only personal display prefs"
```

---

### Task 8: Delete `profile-customization.tsx`, update the Settings menu, clean up unused locale keys

**Files:**
- Delete: `packages/frontend/app/(app)/settings/profile-customization.tsx`
- Modify: `packages/frontend/app/(app)/settings/index.tsx:251-258` (the `profile-customization` `SettingsListItem`), `:220-224` (the `appearance` `SettingsListItem` description)
- Modify: `packages/frontend/locales/en.json`, `packages/frontend/locales/es.json`, `packages/frontend/locales/it.json`

**Interfaces:** none — this task only removes dead code/copy/routes.

- [ ] **Step 1: Delete the old screen**

```bash
git rm packages/frontend/app/\(app\)/settings/profile-customization.tsx
```

- [ ] **Step 2: Remove its Settings menu row**

In `packages/frontend/app/(app)/settings/index.tsx`, delete:
```tsx
                        <SettingsListItem
                            icon={<RowIcon name="person-outline" />}
                            title={t('settings.preferences.profileCustomization')}
                            description={t('settings.preferences.profileCustomizationDesc', { defaultValue: 'Layout, profile color' })}
                            onPress={() => router.push('/settings/profile-customization')}
                        />
```
Leave the surrounding `SettingsListGroup`/`isAuthenticated &&` wrapper and the sibling `Your interests` item intact — only this one `SettingsListItem` is removed. If `Your interests` is the only remaining child of that group, double-check the group still renders sensibly (it will — `SettingsListGroup` doesn't require a minimum child count).

- [ ] **Step 3: Update the `appearance` row's description**

Change:
```tsx
                    <SettingsListItem
                        icon={<RowIcon name="color-palette-outline" />}
                        title={t('settings.preferences.appearance')}
                        description={t('settings.preferences.appearanceDesc', { defaultValue: 'Theme, colors, display' })}
                        onPress={() => router.push('/settings/appearance')}
                    />
```
to:
```tsx
                    <SettingsListItem
                        icon={<RowIcon name="color-palette-outline" />}
                        title={t('settings.preferences.appearance')}
                        description={t('settings.preferences.appearanceDesc', { defaultValue: 'Theme, text, display' })}
                        onPress={() => router.push('/settings/appearance')}
                    />
```
This is inline-default text only (no locale-key change needed) — the same key `settings.preferences.appearanceDesc` is reused; if it has a real translated value in `en.json`/`es.json`/`it.json` (check with `grep -n "settings.preferences.appearanceDesc" packages/frontend/locales/*.json`), update those translated strings too so they no longer claim "colors" live there — translate "Theme, text, display" appropriately per locale rather than leaving stale copy.

- [ ] **Step 4: Remove now-unused locale keys**

The deleted screen was the only consumer of the `settings.profileCustomization.*` keys **except** `profileStyle`/`styleDefault`/`styleDefaultDesc`/`styleMinimalist`/`styleMinimalistDesc` (still used by `ProfileStyleSection`, Task 2) and `profileColorHint`/`info` (check whether Task 4's screen still needs them — it does not, since Task 4 doesn't reproduce the color-picker hint text or the info footer; keep only what Task 2 actually imports).

Run: `grep -rn "settings.profileCustomization\." packages/frontend --include="*.tsx" --include="*.ts" | grep -v node_modules`
For every key listed under `locales/en.json:415-430` (from the original context-gathering), confirm which are still referenced by that grep. Remove the unreferenced ones from `en.json`, `es.json`, and `it.json`: at minimum `settings.preferences.profileCustomization`, `settings.preferences.profileCustomizationDesc`, `settings.profileCustomization.title`, `settings.profileCustomization.coverPhoto`, `settings.profileCustomization.coverPhotoDesc`, `settings.profileCustomization.minimalistMode`, `settings.profileCustomization.minimalistModeDesc`, `settings.profileCustomization.advancedOptions`, `settings.profileCustomization.profileColor`, `settings.profileCustomization.profileColorHint`, `settings.profileCustomization.info` are candidates — verify each against the grep output before deleting, since `signInRequired`/`signInRequiredDesc` are reused verbatim by Task 4's screen (keep those two).

- [ ] **Step 5: Verify locale JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/frontend/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('packages/frontend/locales/es.json','utf8')); JSON.parse(require('fs').readFileSync('packages/frontend/locales/it.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 6: Typecheck and lint**

Run: `cd packages/frontend && bun run typecheck && bun run lint`
Expected: both exit 0. A typecheck failure referencing `/settings/profile-customization` means a leftover `router.push`/`Href` reference to the deleted route still exists somewhere — find it with `grep -rn "profile-customization" packages/frontend --include="*.tsx" --include="*.ts" | grep -v node_modules` and remove it.

- [ ] **Step 7: Commit**

```bash
git add -A packages/frontend/app/\(app\)/settings/ packages/frontend/locales/
git commit -m "chore(frontend): remove profile-customization screen, absorbed into Edit Profile"
```

---

### Task 9: Manual verification pass

**Files:** none — no code changes, verification only.

- [ ] **Step 1: Start the frontend dev server**

Run (from repo root): `bun run dev:frontend`

- [ ] **Step 2: Sign in as an existing test account and open your own profile**

Confirm the "Editar perfil" button navigates to `/edit-profile` (not a `ManageAccount` sheet).

- [ ] **Step 3: Exercise every section on the new screen**

- Banner: upload an image, confirm it previews and persists after a screen remount (navigate away and back); remove it, confirm it clears.
- Profile style: switch between default/minimalist, confirm the selection highlight updates and persists after remount.
- Profile color: pick a different accent color, confirm the app's theme updates live.
- Pinned song/podcast: with nothing pinned, confirm the "Add song or podcast" row opens the picker; search and pin a track; confirm the row now shows the pinned track with an edit affordance; remove it, confirm it reverts to the "Add" row.
- Oxy account row: confirm it opens the `ManageAccount` sheet (same content as before this change).

- [ ] **Step 4: Confirm the public profile no longer shows the inline add-prompt**

With nothing pinned, view your own profile (not Edit Profile) — the area where "+ Add song or podcast" used to appear should render nothing. Pin a track via Edit Profile, then revisit your public profile — the read-only song/podcast card should appear there as before.

- [ ] **Step 5: Confirm Settings no longer has a separate "Profile Customization" entry**

Open Settings — the row that used to say "Profile Customization" should be gone; "Appearance" should still be present and, when opened, should show only theme mode / text-length / read-more / bio-collapse (no banner, no color picker).

- [ ] **Step 6: Check the browser console for errors**

No new errors/warnings introduced by this change (pre-existing unrelated warnings are out of scope).

- [ ] **Step 7: Report results**

Summarize what was checked and any deviations from expected behavior before considering this plan complete — per this project's standing rule, a UI change is not "done" without this manual pass.
