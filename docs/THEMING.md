# Theming

Mention uses Bloom as the single theme authority on web and native. Do not add
app-local color scales, duplicate Bloom CSS variables, or introduce another
theme hook.

## Runtime theme

`packages/frontend/app/_layout.tsx` mounts `BloomThemeProvider` once with the
system color mode and the blue preset as defaults. The provider owns the active
mode, color preset, font loading and local persistence.

Read theme values directly from Bloom:

```tsx
import { useTheme } from '@oxy.so/bloom/theme';

function Example() {
  const { colors } = useTheme();
  return <Text style={{ color: colors.text }}>Mention</Text>;
}
```

Use semantic values such as `background`, `card`, `text`, `textSecondary`,
`border`, `primary` and `error`. Do not copy their literal color values into
components. Prefer Bloom components and semantic NativeWind utilities such as
`bg-background`, `bg-card`, `text-foreground` and
`text-muted-foreground` when they fit the component.

## Chrome that matches its surface

`bg-card` is a palette token: the colour a CARD paints. It is the wrong answer
for chrome whose only job is to be opaque in the colour of whatever it is
sitting on — the feed column, a sticky tab bar or header, a pinned reply
composer, the profile banner fade. Those ask instead:

```tsx
import { useSurfaceFill } from '@oxy.so/bloom/styles';

const surfaceFill = useSurfaceFill();
<View style={{ backgroundColor: surfaceFill }} />
```

The shell's `ContentPanel` publishes `colors.card`, a bottom sheet publishes
`colors.background`, and anything unwrapped gets the page — so one component
lands correctly on all three instead of naming the one it was written for. Any
container of ours that repaints a Bloom surface has to say what it painted
(`ContentPanel`'s `surfaceColor`), or its content is told the wrong colour.

On web the same value is `var(--bloom-surface)`, but a `var(--bloom-surface)`
class in SHARED code is right on web and silently wrong on native: only a
`.web.tsx` fork or a stylesheet may read it. Cross-platform code uses the hook.

`SettingsListGroup` reads the surface the same way, which is why no call site
here passes `variant`.

## Design tokens

`packages/frontend/global.css` imports the canonical token sheet:

```css
@import "@oxy.so/bloom/design-tokens/theme.css";
```

Keep that import after Tailwind and NativeWind imports. Bloom's file is the
source of truth for colors, radii, spacing and typography. Mention's local
`@theme` block is only for genuine app aliases; never paste Bloom token scales
into it.

## User and profile colors

- Theme mode and the app color preset are changed through
  `hooks/useAccountTheme.ts`. When account sync is selected, changes are also
  persisted through Oxy.
- Route-specific profile colors use `BloomColorScope` with a validated
  `AppColorName`. Keep scopes narrow so a profile color cannot leak into another
  route.
- Components inside a scope should read `useTheme()` normally. A component that
  needs the unscoped shell background must receive it explicitly from outside
  the scope, as `ContentPanel` does with `maskColor`.

## Review checklist

- Import theme APIs from `@oxy.so/bloom/theme`; there is no
  `@/hooks/useTheme`.
- Use semantic tokens instead of hard-coded light/dark colors.
- Keep one `BloomThemeProvider` at the application root.
- Use `BloomColorScope` only for bounded route or component customization.
- Verify both light and dark modes, account-synced and local themes, and profile
  color scopes on web and native.
