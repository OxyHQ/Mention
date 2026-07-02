# Read-more tap behavior + bio collapse settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Mention-only viewer-side display preferences — whether tapping a post's "Read more" opens the full post or expands it inline, and whether long profile bios collapse by default — following the exact plumbing of the existing `postTextExpand` setting.

**Architecture:** Two new optional fields on `UserSettings.appearance` (backend Mongoose schema + route whitelist), mirrored in the frontend `appearanceStore` types, consumed via a new shared `useExpandableText` hook (a thin `useState` wrapper around a pure, unit-tested truncation function) used by both `PostContentText.tsx` and `ProfileContent.tsx`'s bio rendering.

**Tech Stack:** Express + Mongoose (backend), React Native + Zustand + react-i18next (frontend), Vitest (backend tests), Jest + jest-expo (frontend tests).

## Global Constraints

- Backend and frontend settings field names must match exactly: `postReadMoreAction: 'openPost' | 'expandInline'` (default `'openPost'`), `collapseLongBio: boolean` (default `true`).
- Bio collapse threshold is a fixed constant: **200 characters**. Not user-configurable (only the on/off toggle is).
- The "Read more" label text never changes based on the setting — only what tapping it does changes.
- No i18n JSON file edits — this codebase's established convention (confirmed in `PostContentText.tsx`, `ProfileScreen.tsx`, etc.) is the inline `t('some.key', { defaultValue: 'English text' })` pattern with no corresponding `locales/en.json` entries required.
- No `as any`, no `@ts-ignore`, no silent catches, no new `useEffect` unless unavoidable (per this repo's AGENTS.md).
- The frontend `saveSettings` callback in `appearance.tsx` PUTs the **entire** `appearance` object on every save (not a partial patch) — any new field added to that call site MUST default to the *current* stored value when not the field being changed, exactly like the existing `postTextExpand`/`themeMode`/`primaryColor` fields do. Omitting a field here would silently wipe it server-side on the next unrelated settings change (confirmed: the backend route does `update['appearance'] = {...}` as one object, then `$set: { appearance: {...} }` — a full-document replace of the `appearance` subdocument, not a per-field dot-notation patch).

---

### Task 1: Backend — `postReadMoreAction` + `collapseLongBio` settings fields

**Files:**
- Modify: `packages/backend/src/models/UserSettings.ts:1-16` (types), `:152-156` (schema)
- Modify: `packages/backend/src/routes/profileSettings.ts:89-102`
- Test: `packages/backend/src/__tests__/routes/profileSettingsReadMoreBio.test.ts` (new)

**Interfaces:**
- Produces: `AppearanceSettings.postReadMoreAction?: 'openPost' | 'expandInline'`, `AppearanceSettings.collapseLongBio?: boolean` — the frontend's `store/appearanceStore.ts` (Task 2) mirrors this exact shape.

- [ ] **Step 1: Write the failing route test**

Create `packages/backend/src/__tests__/routes/profileSettingsReadMoreBio.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for `postReadMoreAction` + `collapseLongBio` in the
 * `PUT /profile/settings` handler. Same harness shape as
 * `profileSettingsExternalEmbeds.test.ts` — exercises the real route handler
 * against an in-memory UserSettings store.
 */

const store = new Map<string, Record<string, unknown>>();
const TEST_USER = 'user-1';

function getDoc(oxyUserId: string): Record<string, unknown> {
  let doc = store.get(oxyUserId);
  if (!doc) {
    doc = { oxyUserId };
    store.set(oxyUserId, doc);
  }
  return doc;
}

const FORBIDDEN_DOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setDot(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (FORBIDDEN_DOT_KEYS.has(parts[i])) return;
    const next = cur[parts[i]];
    if (typeof next !== 'object' || next === null) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN_DOT_KEYS.has(last)) return;
  cur[last] = value;
}

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    findOneAndUpdate: vi.fn((filter: { oxyUserId: string }, operation: Record<string, Record<string, unknown>>) => {
      const doc = getDoc(filter.oxyUserId);
      if (operation.$set) {
        for (const [path, value] of Object.entries(operation.$set)) setDot(doc, path, value);
      }
      return { lean: () => Promise.resolve(JSON.parse(JSON.stringify(doc))) };
    }),
  },
}));

vi.mock('../../utils/userSettings', () => ({
  ensureUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  buildSettingsResponseForViewer: (
    doc: unknown,
    targetUserId: string,
    viewerUserId: string,
  ) => (targetUserId === viewerUserId ? doc : {}),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/syraPodcast', () => ({
  syraClient: {},
}));
vi.mock('../../models/UserBehavior', () => ({ default: {} }));
vi.mock('../../models/Post', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

async function getSettings() {
  const res = await request(app).get('/profile/settings/me').expect(200);
  return res.body.data as Record<string, unknown>;
}

describe('PUT /profile/settings — postReadMoreAction + collapseLongBio', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('persists a valid postReadMoreAction value', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'expandInline' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).postReadMoreAction).toBe('expandInline');
  });

  it('rejects an invalid postReadMoreAction value (field left unset)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'bogus' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown> | undefined)?.postReadMoreAction).toBeUndefined();
  });

  it('persists collapseLongBio as a boolean', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: false } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).collapseLongBio).toBe(false);
  });

  it('rejects a non-boolean collapseLongBio value (field left unset)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: 'yes' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown> | undefined)?.collapseLongBio).toBeUndefined();
  });

  it('still persists themeMode alongside the two new fields in the same request', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { themeMode: 'dark', postReadMoreAction: 'expandInline', collapseLongBio: false } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.appearance).toEqual({
      themeMode: 'dark',
      postReadMoreAction: 'expandInline',
      collapseLongBio: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend && bunx vitest run src/__tests__/routes/profileSettingsReadMoreBio.test.ts`
Expected: FAIL — `postReadMoreAction`/`collapseLongBio` are `undefined` even for the "valid value" tests, because the route doesn't whitelist them yet (the first and third `it` blocks fail; the reject/unset ones already trivially pass, which is a good sign the test file itself is wired correctly).

- [ ] **Step 3: Add the fields to the Mongoose model**

In `packages/backend/src/models/UserSettings.ts`, update the type block (around line 10-16):

```ts
export type PostTextExpand = 'default' | 'more' | 'muchMore' | 'all';

/** Behavior when tapping a truncated post's "Read more" link. */
export type PostReadMoreAction = 'openPost' | 'expandInline';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
  postTextExpand?: PostTextExpand;
  postReadMoreAction?: PostReadMoreAction;
  collapseLongBio?: boolean;
}
```

Update the schema (around line 152-156):

```ts
const AppearanceSchema = new Schema<AppearanceSettings>({
  themeMode: { type: String, enum: ['light', 'dark', 'system', 'adaptive'], default: 'system' },
  primaryColor: { type: String, default: undefined },
  postTextExpand: { type: String, enum: ['default', 'more', 'muchMore', 'all'], default: 'default' },
  postReadMoreAction: { type: String, enum: ['openPost', 'expandInline'], default: 'openPost' },
  collapseLongBio: { type: Boolean, default: true },
}, { _id: false });
```

- [ ] **Step 4: Whitelist the fields in the route**

In `packages/backend/src/routes/profileSettings.ts`, extend the `appearance` validation block (around line 89-102):

```ts
    if (appearance) {
      update['appearance'] = {};
      if (appearance.themeMode && ['light', 'dark', 'system'].includes(appearance.themeMode)) {
        update.appearance.themeMode = appearance.themeMode;
      }
      if (typeof appearance.primaryColor === 'string' && appearance.primaryColor.trim()) {
        update.appearance.primaryColor = appearance.primaryColor.trim();
      } else if (appearance.primaryColor === null) {
        update.appearance.primaryColor = undefined;
      }
      if (['default', 'more', 'muchMore', 'all'].includes(appearance.postTextExpand)) {
        update.appearance.postTextExpand = appearance.postTextExpand;
      }
      if (['openPost', 'expandInline'].includes(appearance.postReadMoreAction)) {
        update.appearance.postReadMoreAction = appearance.postReadMoreAction;
      }
      if (typeof appearance.collapseLongBio === 'boolean') {
        update.appearance.collapseLongBio = appearance.collapseLongBio;
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/backend && bunx vitest run src/__tests__/routes/profileSettingsReadMoreBio.test.ts`
Expected: PASS (5/5)

- [ ] **Step 6: Run the full backend test suite to confirm no regressions**

Run: `cd packages/backend && bun run test`
Expected: PASS (all suites, including the untouched `profileSettingsExternalEmbeds.test.ts`)

- [ ] **Step 7: Typecheck**

Run: `cd packages/backend && bunx tsc --noEmit`
Expected: no new errors

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/models/UserSettings.ts packages/backend/src/routes/profileSettings.ts packages/backend/src/__tests__/routes/profileSettingsReadMoreBio.test.ts
git commit -m "feat(backend): add postReadMoreAction + collapseLongBio appearance settings"
```

---

### Task 2: Frontend — `appearanceStore` type additions

**Files:**
- Modify: `packages/frontend/store/appearanceStore.ts:27-32`

**Interfaces:**
- Consumes: none (pure type addition).
- Produces: `export type PostReadMoreAction = 'openPost' | 'expandInline';`, `AppearanceSettings.postReadMoreAction?: PostReadMoreAction`, `AppearanceSettings.collapseLongBio?: boolean` — consumed by Task 4 (settings UI), Task 5 (`PostContentText.tsx`), Task 6 (`ProfileContent.tsx`).

- [ ] **Step 1: Add the type and field**

In `packages/frontend/store/appearanceStore.ts`, right after the existing `PostTextExpand` type (line 27) and inside `AppearanceSettings` (lines 29-32):

```ts
export type PostTextExpand = 'default' | 'more' | 'muchMore' | 'all';

/** Behavior when tapping a truncated post's "Read more" link. */
export type PostReadMoreAction = 'openPost' | 'expandInline';

export interface AppearanceSettings {
  themeMode?: ThemeMode;
  primaryColor?: string;
  postTextExpand?: PostTextExpand;
  postReadMoreAction?: PostReadMoreAction;
  collapseLongBio?: boolean;
}
```

(Keep whatever other existing fields/formatting are already in this interface — only add the two new lines and the new exported type; don't reformat unrelated fields.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i appearanceStore`
Expected: no output (no errors referencing this file)

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/store/appearanceStore.ts
git commit -m "feat(frontend): add postReadMoreAction + collapseLongBio to appearance store types"
```

---

### Task 3: Frontend — expandable-text logic + hook

**Files:**
- Create: `packages/frontend/utils/expandableText.ts`
- Create: `packages/frontend/utils/__tests__/expandableText.test.ts`
- Create: `packages/frontend/hooks/useExpandableText.ts`

**Interfaces:**
- Produces:
  - `computeExpandableText(text: string, maxChars: number, isExpanded: boolean): { displayText: string; isTruncated: boolean }`
  - `useExpandableText(text: string, maxChars: number): { displayText: string; isTruncated: boolean; isExpanded: boolean; toggle: () => void }`
  - Consumed by Task 5 (`PostContentText.tsx`) and Task 6 (`ProfileContent.tsx`).

- [ ] **Step 1: Write the failing test for the pure function**

Create `packages/frontend/utils/__tests__/expandableText.test.ts`:

```ts
import { computeExpandableText } from '../expandableText';

describe('computeExpandableText', () => {
  it('does not truncate when text is shorter than maxChars', () => {
    const result = computeExpandableText('short text', 200, false);
    expect(result).toEqual({ displayText: 'short text', isTruncated: false });
  });

  it('does not truncate when text is exactly maxChars', () => {
    const text = 'a'.repeat(200);
    const result = computeExpandableText(text, 200, false);
    expect(result).toEqual({ displayText: text, isTruncated: false });
  });

  it('truncates with an ellipsis when text exceeds maxChars and not expanded', () => {
    const text = 'a'.repeat(250);
    const result = computeExpandableText(text, 200, false);
    expect(result.isTruncated).toBe(true);
    expect(result.displayText).toBe(`${'a'.repeat(200)}…`);
  });

  it('trims trailing whitespace before the ellipsis', () => {
    const text = `${'a'.repeat(199)} ${'b'.repeat(50)}`;
    const result = computeExpandableText(text, 200, false);
    expect(result.isTruncated).toBe(true);
    expect(result.displayText.endsWith(' …')).toBe(false);
  });

  it('returns the full text when exceeding maxChars but isExpanded is true', () => {
    const text = 'a'.repeat(250);
    const result = computeExpandableText(text, 200, true);
    expect(result).toEqual({ displayText: text, isTruncated: true });
  });

  it('treats Infinity maxChars as never-truncate', () => {
    const text = 'a'.repeat(10000);
    const result = computeExpandableText(text, Infinity, false);
    expect(result).toEqual({ displayText: text, isTruncated: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/frontend && bunx jest utils/__tests__/expandableText.test.ts`
Expected: FAIL with "Cannot find module '../expandableText'"

- [ ] **Step 3: Implement the pure function**

Create `packages/frontend/utils/expandableText.ts`:

```ts
/**
 * Pure truncation logic shared by post body text and profile bios. Both
 * "Read more" (post, when the openPost setting is off) and profile bio use
 * the identical truncate/expand shape; only the UI around it differs, which
 * is why this stays a plain function with no React/RN dependency.
 */
export function computeExpandableText(
  text: string,
  maxChars: number,
  isExpanded: boolean
): { displayText: string; isTruncated: boolean } {
  const isTruncated = text.length > maxChars;
  if (!isTruncated || isExpanded) {
    return { displayText: text, isTruncated };
  }
  return { displayText: `${text.slice(0, maxChars).trimEnd()}…`, isTruncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/frontend && bunx jest utils/__tests__/expandableText.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Implement the hook**

Create `packages/frontend/hooks/useExpandableText.ts`:

```ts
import { useCallback, useState } from 'react';
import { computeExpandableText } from '@/utils/expandableText';

/**
 * Stateful wrapper around `computeExpandableText`. Not unit-tested directly
 * (it's a thin useState binding with no branching of its own) — the
 * truncation logic itself is covered by `utils/__tests__/expandableText.test.ts`.
 */
export function useExpandableText(text: string, maxChars: number) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { displayText, isTruncated } = computeExpandableText(text, maxChars, isExpanded);
  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);
  return { displayText, isTruncated, isExpanded, toggle };
}
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -iE "expandableText|useExpandableText"`
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/utils/expandableText.ts packages/frontend/utils/__tests__/expandableText.test.ts packages/frontend/hooks/useExpandableText.ts
git commit -m "feat(frontend): add shared expandable-text truncation logic + hook"
```

---

### Task 4: Frontend — Settings UI

**Files:**
- Modify: `packages/frontend/app/(app)/settings/appearance.tsx`

**Interfaces:**
- Consumes: `PostReadMoreAction` type + `AppearanceSettings.postReadMoreAction`/`collapseLongBio` from Task 2 (`@/store/appearanceStore`).
- Produces: nothing new consumed by later tasks — this is the leaf settings screen.

- [ ] **Step 1: Extend imports and local state**

In `packages/frontend/app/(app)/settings/appearance.tsx`, update the import (line 3):

```ts
import { useAppearanceStore, type PostTextExpand, type PostReadMoreAction } from '@/store/appearanceStore';
```

Add local derived values right after the existing `postTextExpand` line (line 40):

```ts
  const postTextExpand: PostTextExpand = mySettings?.appearance?.postTextExpand ?? 'default';
  const postReadMoreAction: PostReadMoreAction = mySettings?.appearance?.postReadMoreAction ?? 'openPost';
  const collapseLongBio: boolean = mySettings?.appearance?.collapseLongBio ?? true;
```

- [ ] **Step 2: Extend `saveSettings` to always include both new fields**

Replace the `saveSettings` callback (lines 68-79) — this MUST keep sending every appearance field on every save, per the Global Constraints note on the backend's full-subdocument replace:

```ts
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

- [ ] **Step 3: Add the two change handlers**

Right after `onPostTextExpandChange` (line 86-88):

```ts
  const onPostReadMoreActionChange = useCallback((value: PostReadMoreAction) => {
    void saveSettings({ postReadMoreAction: value });
  }, [saveSettings]);

  const onCollapseLongBioChange = useCallback((value: 'collapse' | 'full') => {
    void saveSettings({ collapseLongBio: value === 'collapse' });
  }, [saveSettings]);
```

- [ ] **Step 4: Add the two SegmentedControl rows to the JSX**

Right after the existing "Post text length" block's closing `<SettingsListDivider />` (after line 194), insert two new blocks before the "Accent color" section:

```tsx
        {/* Read more tap behavior */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="expand-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.readMoreAction', 'On "Read more" tap')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.readMoreAction', 'On "Read more" tap')}
            type="radio"
            value={postReadMoreAction}
            onChange={onPostReadMoreActionChange}>
            <SegmentedControlItem value="openPost">
              <SegmentedControlItemText>{t('settings.appearance.readMoreAction.openPost', 'Open post')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="expandInline">
              <SegmentedControlItemText>{t('settings.appearance.readMoreAction.expandInline', 'Expand here')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Profile bio collapse */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="reader-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.collapseBio', 'Profile bios')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.collapseBio', 'Profile bios')}
            type="radio"
            value={collapseLongBio ? 'collapse' : 'full'}
            onChange={onCollapseLongBioChange}>
            <SegmentedControlItem value="collapse">
              <SegmentedControlItemText>{t('settings.appearance.collapseBio.collapse', 'Collapse if long')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="full">
              <SegmentedControlItemText>{t('settings.appearance.collapseBio.full', 'Always show full')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />
```

Verify `Icon` (from `@/lib/icons`, already imported at the top of this file) actually has `expand-outline` and `reader-outline` registered — these are standard Ionicons names already used elsewhere in this codebase's `Icon` wrapper (same Ionicons set as `phone-portrait`/`text-outline`/`color-palette` already used two blocks above in this same file). If either name doesn't render, substitute any other existing Ionicons name already used in this file's icon set — the icon choice is not load-bearing for the feature.

- [ ] **Step 5: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i "settings/appearance"`
Expected: no output

- [ ] **Step 6: Lint**

Run: `cd packages/frontend && bunx eslint app/\(app\)/settings/appearance.tsx`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add "packages/frontend/app/(app)/settings/appearance.tsx"
git commit -m "feat(frontend): add Read-more-tap and bio-collapse controls to Appearance settings"
```

---

### Task 5: Frontend — `PostContentText.tsx` wiring

**Files:**
- Modify: `packages/frontend/components/Post/PostContentText.tsx`

**Interfaces:**
- Consumes: `useExpandableText` from Task 3, `AppearanceSettings.postReadMoreAction` from Task 2.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Replace the truncation logic with the shared hook**

Current file (for reference, full contents before this change):

```tsx
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';
import { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/store/appearanceStore';

interface Props {
  content?: string | PostContent;
  postId?: string;
  previewChars?: number;
  translatedText?: string | null;
  linkPreviewUrl?: string | null;
}

const TRAILING_URL_RE = /\s*(https?:\/\/[^\s]+|www\.[^\s]+)\s*$/;

/** In-feed truncation thresholds (chars) per the `postTextExpand` preference. */
const PREVIEW_CHARS = { default: 280, more: 600, muchMore: 1200, all: Infinity } as const;

const PostContentText: React.FC<Props> = ({ content, postId, previewChars, translatedText, linkPreviewUrl }) => {
  const router = useRouter();
  const pathname = usePathname();
  const postTextExpand = useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default';
  const effectivePreviewChars = previewChars ?? PREVIEW_CHARS[postTextExpand];
  const originalText = typeof content === 'string' ? content : content?.text || '';
  const rawText = translatedText || originalText;

  const textContent = linkPreviewUrl
    ? rawText.replace(TRAILING_URL_RE, (match, url) => url === linkPreviewUrl ? '' : match)
    : rawText;

  if (!textContent) return null;

  const isDetailPage = pathname?.startsWith('/p');
  const shouldTruncate = !isDetailPage && textContent.length > effectivePreviewChars;
  const displayed = shouldTruncate ? `${textContent.slice(0, effectivePreviewChars).trimEnd()}…` : textContent;

  const suffix = shouldTruncate && postId ? (
    <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
      {' Read more'}
    </Text>
  ) : null;

  return (
    <LinkifiedText
      text={displayed}
      style={styles.postText}
      className="text-foreground"
      suffix={suffix}
    />
  );
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    lineHeight: 20,
  },
});
```

New version:

```tsx
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';
import { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useExpandableText } from '@/hooks/useExpandableText';
import { useTranslation } from 'react-i18next';

interface Props {
  content?: string | PostContent;
  postId?: string;
  previewChars?: number;
  translatedText?: string | null;
  linkPreviewUrl?: string | null;
}

const TRAILING_URL_RE = /\s*(https?:\/\/[^\s]+|www\.[^\s]+)\s*$/;

/** In-feed truncation thresholds (chars) per the `postTextExpand` preference. */
const PREVIEW_CHARS = { default: 280, more: 600, muchMore: 1200, all: Infinity } as const;

const PostContentText: React.FC<Props> = ({ content, postId, previewChars, translatedText, linkPreviewUrl }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const postTextExpand = useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default';
  const postReadMoreAction = useAppearanceStore((s) => s.mySettings?.appearance?.postReadMoreAction) ?? 'openPost';
  const effectivePreviewChars = previewChars ?? PREVIEW_CHARS[postTextExpand];
  const originalText = typeof content === 'string' ? content : content?.text || '';
  const rawText = translatedText || originalText;

  const textContent = linkPreviewUrl
    ? rawText.replace(TRAILING_URL_RE, (match, url) => url === linkPreviewUrl ? '' : match)
    : rawText;

  const isDetailPage = pathname?.startsWith('/p');
  // On the detail page, never truncate — feed it Infinity so the hook is a no-op.
  const { displayText, isTruncated, isExpanded, toggle } = useExpandableText(
    textContent,
    isDetailPage ? Infinity : effectivePreviewChars
  );

  if (!textContent) return null;

  const suffix = isTruncated && postId ? (
    postReadMoreAction === 'expandInline' ? (
      <Text className="text-primary" onPress={toggle}>
        {isExpanded ? ` ${t('common.showLess', 'Show less')}` : ' Read more'}
      </Text>
    ) : (
      <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
        {' Read more'}
      </Text>
    )
  ) : null;

  return (
    <LinkifiedText
      text={displayText}
      style={styles.postText}
      className="text-foreground"
      suffix={suffix}
    />
  );
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    lineHeight: 20,
  },
});
```

Note the behavior is identical to today's when `postReadMoreAction` is `'openPost'` (the default): `isTruncated` replaces the old `shouldTruncate` check (same condition, just computed inside the hook), and the suffix branch for `'openPost'` is byte-for-byte the previous suffix.

- [ ] **Step 2: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i PostContentText`
Expected: no output

- [ ] **Step 3: Lint**

Run: `cd packages/frontend && bunx eslint components/Post/PostContentText.tsx`
Expected: 0 errors

- [ ] **Step 4: Manual verification (real device/browser check — this is UI behavior, not unit-testable without a render harness this codebase doesn't have)**

- Confirm a long post's "Read more" still navigates to `/p/[id]` by default (no settings changed).
- In Settings → Appearance, switch "On Read more tap" to "Expand here". Return to the feed: tapping "Read more" on a long post now reveals the full text in place, with the link changed to "Show less"; tapping "Show less" re-collapses it.
- Confirm the post detail page (`/p/[id]`) still always shows full text regardless of the setting.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/components/Post/PostContentText.tsx
git commit -m "feat(frontend): wire postReadMoreAction into PostContentText"
```

---

### Task 6: Frontend — Profile bio collapse

**Files:**
- Modify: `packages/frontend/components/Profile/ProfileContent.tsx:1-22` (imports), `:140-147` (bio render)

**Interfaces:**
- Consumes: `useExpandableText` from Task 3, `AppearanceSettings.collapseLongBio` from Task 2.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add imports**

In `packages/frontend/components/Profile/ProfileContent.tsx`, add two imports alongside the existing ones (near line 20-22):

```ts
import { useAppearanceStore } from '@/store/appearanceStore';
import { useExpandableText } from '@/hooks/useExpandableText';
```

- [ ] **Step 2: Add the bio-collapse constant**

Near the top of the file, alongside other module-level constants (or right below the imports if none exist yet):

```ts
/** Profile bio collapse threshold (chars) — fixed, not user-configurable; only the on/off toggle is (`collapseLongBio`). */
const BIO_COLLAPSE_CHARS = 200;
```

- [ ] **Step 3: Replace the bio render block**

Current (lines 140-147):

```tsx
      {/* Bio */}
      {!minimalistMode && profileData.bio && (
        <LinkifiedText
          text={profileData.bio}
          className="text-foreground"
          style={{ fontSize: 15, lineHeight: 20, marginBottom: 12 }}
        />
      )}
```

`t` is already destructured at the top of `ProfileContent` (`const { t } = useTranslation();`, right after the `ProfileContentProps` destructuring) — reuse it, don't add a second `useTranslation()` call. Insert the two new lines directly after the existing `profileHandle` block and before `handleLayout`:

```ts
  const { t } = useTranslation();
  const design = profileData.design;
  const minimalistMode = design.minimalistMode;
  const profileHandle = getNormalizedUserHandle({
    username: profileData.username || username,
    instance: profileData.instance,
    isFederated: profileData.isFederated,
  }) || username;
  const collapseLongBio = useAppearanceStore((s) => s.mySettings?.appearance?.collapseLongBio) ?? true;
  const bioExpand = useExpandableText(profileData.bio ?? '', collapseLongBio ? BIO_COLLAPSE_CHARS : Infinity);

  const handleLayout = (event: LayoutChangeEvent) => {
    onLayout?.(event.nativeEvent.layout.height);
  };
```

(Only the two new `collapseLongBio`/`bioExpand` lines are additions — everything else shown above is existing code, reproduced so the insertion point is unambiguous.)

(If `useTranslation`'s `t` is already destructured earlier in this component, do not re-declare it — just reuse that existing binding.)

```tsx
      {/* Bio */}
      {!minimalistMode && profileData.bio && (
        <LinkifiedText
          text={bioExpand.displayText}
          className="text-foreground"
          style={{ fontSize: 15, lineHeight: 20, marginBottom: 12 }}
          suffix={bioExpand.isTruncated ? (
            <Text
              className="text-primary"
              onPress={bioExpand.toggle}
            >
              {bioExpand.isExpanded ? ` ${t('common.showLess', 'Show less')}` : ` ${t('profile.bio.readMore', 'Read more')}`}
            </Text>
          ) : null}
        />
      )}
```

`Text` is already imported in this file (`react-native`, line 2) — no new import needed for it. Confirm `LinkifiedText`'s `suffix` prop is passed correctly (it's `React.ReactNode`, same as `PostContentText.tsx`'s usage).

- [ ] **Step 4: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i ProfileContent`
Expected: no output

- [ ] **Step 5: Lint**

Run: `cd packages/frontend && bunx eslint components/Profile/ProfileContent.tsx`
Expected: 0 errors

- [ ] **Step 6: Manual verification**

- Open a profile with a bio under 200 chars → renders exactly as before (no "Read more", no change).
- Open a profile with a bio over 200 chars, default settings → bio truncates at 200 chars with a "Read more" suffix; tapping it expands to the full bio with "Show less"; tapping that re-collapses.
- In Settings → Appearance, switch "Profile bios" to "Always show full" → the same long-bio profile now shows the complete bio with no truncation and no Read-more/Show-less affordance at all.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/components/Profile/ProfileContent.tsx
git commit -m "feat(frontend): add collapseLongBio-driven bio truncation to ProfileContent"
```

---

## Post-plan verification (all tasks complete)

- [ ] Run `cd packages/backend && bun run test` — full suite green.
- [ ] Run `cd packages/backend && bunx tsc --noEmit` — no errors.
- [ ] Run `cd packages/frontend && bun run lint` — 0 errors, no new warnings vs. baseline.
- [ ] Run `cd packages/frontend && bunx tsc --noEmit -p .` — no new errors (3 allow-listed livekit externals ignored, per this repo's established convention).
- [ ] Run `cd packages/frontend && bun run test` — full suite green (includes the new `expandableText.test.ts`).
- [ ] Real-device/browser walkthrough per Task 5 Step 4 and Task 6 Step 6 above.
