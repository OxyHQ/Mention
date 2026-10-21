# Theme
Inter sans; Bloom semantic color tokens, no app overrides. White/light canvas, near-black foreground, muted secondary text, border hairlines. Blue primary preset; spacing in 4px steps, typography body 15px, title 20–24px. Dark mode follows Bloom. Content uses simple separators without extra shadow/card frames.
## packages/frontend/global.css
```css
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css";
@import "nativewind/theme";

/* Bloom canonical design tokens (RADIUS scale, spacing, typography, color
   aliases). Single source of truth = @oxy.so/bloom/design-tokens theme.css,
   generated from bloomThemeCss(). Bloom components (e.g. ContentPanel from
   @oxy.so/bloom/content-panel) emit `rounded-radius-28` literal utilities that
   resolve from these `--radius-*` namespace tokens. Imported instead of
   hand-copied so it stays in sync with the published package. Mention's own
   `@theme` block below runs AFTER this import, so app-local aliases win on any
   overlap. */
@import "@oxy.so/bloom/design-tokens/theme.css";

@source "./app/**/*.{js,jsx,ts,tsx}";
@source "./components/**/*.{js,jsx,ts,tsx}";
@source "./lib/**/*.{js,jsx,ts,tsx}";
@source "./hooks/**/*.{js,jsx,ts,tsx}";
@source "../../node_modules/@oxy.so/services/lib/**/*.{js,jsx}";
@source "../../node_modules/@oxy.so/bloom/lib/**/*.{js,jsx}";
/* The live-rooms UI (RoomCard, the room sheets) ships NativeWind classNames from
   the Syra SDK, so Tailwind has to scan that package too or those utilities are
   never generated. Measured on 2026-09-22 by building this file with
   `@tailwindcss/postcss`: without this line `rounded-[4px]` and `border-surface`
   — the two classes only Syra ships — are ABSENT from the output. */
@source "../../node_modules/@syra.fm/sdk/lib/**/*.{js,jsx}";

/* Colour utilities (`bg-card`, `bg-primary`, `text-muted-foreground`, …) come
   from Bloom's imported theme.css — the single source of truth — so they are
   NOT re-declared here. Per-app duplication is exactly what let `--color-card`
   drift to `var(--surface)` (card === surface no longer holds: card is the
   lightest surface). */
@theme {
  /* Shell breakpoints, as CSS.

     `hooks/useOptimizedMediaQuery.ts` already draws the line: a JS width read is
     for MOUNT gates and data-level decisions, and "pure show/hide and pure
     styling differences use NativeWind responsive classes — NOT these hooks".
     Naming the widths here is what lets the shell keep that rule instead of
     re-rendering on every resize frame to pick a class name.

     The numbers are the hook's, unchanged. */
  --breakpoint-shell: 500px;

  /* The LAYERED value, outranked by the unlayered `:root` rule below. It
     registers the token, which is what makes the `font-sans` utility exist. */
  --font-sans: var(--bloom-font-sans);

  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
}

@layer base {
  :root {
    --radius: 1rem;
  }
}

@layer utilities {
  .squircle {
    border-radius: 20%;
  }
}

/* Bloom's typeface, not one of Mention's own. NativeWind's theme.css ships an
   UNLAYERED `:root { @media ios { --font-sans: System } }` that outranks anything
   `@theme` emits, so restate Bloom's family here, unlayered and after that import.
   Native gets the bare family name: RN's `fontFamily` takes ONE family, not a CSS
   stack, and `--bloom-font-*` is web-only (injected at runtime by
   `applyFontFaces`). The `var()` fallback covers the static export's first paint,
   before that runs. The literal names mirror `fontFamilies.sans` in @oxy.so/bloom/fonts;
   keep them in step when Bloom changes its default. */
:root {
  --font-sans: var(
    --bloom-font-sans,
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif
  );

  @media ios {
    --font-sans: Inter;
  }

  @media android {
    --font-sans: Inter;
  }
}

html,
body,
#root {
  font-family: var(--font-sans);
  /* Pre-hydration dark canvas. Bloom applies the real theme (the `.dark` class +
     `--background` var) at RUNTIME from BloomThemeProvider, so before the JS
     bundle runs there is no themed background and the first paint would be white.
     This render-blocking rule (global.css ships as a <link rel=stylesheet> in the
     head, before the deferred bundle) paints the boot canvas the same dark as the
     always-dark AppSplashScreen (#0B0B0F, matching the native splash), killing the
     white flash with no worker/JS. The app's own `bg-background` covers it once
     mounted. This is the Expo analog of the Vite apps' static `<html class="dark">`. */
  background-color: #0b0b0f;
}

/* Document-level scrolling. Expo / react-native-web automatically inject a
   "recommended style reset" into the served HTML that locks
   `html, body { height: 100%; overflow: hidden }` and `#root { height: 100% }`
   for a native-like fixed viewport. (This is separate from <ScrollViewStyleReset />.)
   These plain, UNLAYERED rules override it so the DOCUMENT scrolls: the body
   grows with its content and scrolling works from anywhere, including over the
   sticky SideBar / RightBar columns. `#root { min-height: 100vh }` is required
   so the flex root does not collapse to 0 height when `height: auto` is applied.
   No runtime JS. */
/* NOTE: `overflow` MUST be `visible` on BOTH axes here. Setting one axis to
   `hidden`/`clip`/`auto`/`scroll` triggers CSS "overflow promotion" — the other
   `visible` axis computes to `auto`, turning body into a scroll container (so the
   inner body scrolls and the DOCUMENT does not). Any wanted horizontal clipping
   goes on a CHILD, never here. */
html,
body {
  height: auto !important;
  min-height: 100% !important;
  overflow: visible !important;
}

#root {
  height: auto !important;
  min-height: 100vh !important;
  overflow: visible !important;
}

```

## packages/frontend/tailwind.config.js
```tsx
/** @type {import('tailwindcss').Config} */
module.exports = {
  important: true,
  darkMode: 'class',
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './lib/**/*.{js,jsx,ts,tsx}',
    './hooks/**/*.{js,jsx,ts,tsx}',
    '../../node_modules/@oxy.so/services/lib/**/*.{js,jsx}',
    '../../node_modules/@oxy.so/bloom/lib/**/*.{js,jsx}',
    // The live-rooms UI (RoomCard, sheets) ships NativeWind classNames from the
    // Syra SDK; Tailwind must scan the package so those classes are generated.
    '../../node_modules/@syra.fm/sdk/lib/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'hsl(0 0% 100%)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--surface-foreground)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--surface-foreground)',
        },
        'content-area': {
          DEFAULT: 'var(--content-area)',
        },
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
          5: 'var(--chart-5)',
        },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          primary: 'var(--sidebar-primary)',
          'primary-foreground': 'var(--sidebar-primary-foreground)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)',
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

```

## node_modules/@oxy.so/bloom/src/design-tokens/theme.css
```css
/*
 * AUTO-GENERATED by scripts/generate-theme-css.ts — DO NOT EDIT.
 * Source of truth: bloomThemeCss() in src/design-tokens/theme-css.ts.
 * Re-run `bun run generate:theme-css` (or any `bun run build`) after
 * changing any design token.
 */

@theme {
  --color-status-blue-background: var(--info-subtle);
  --color-status-blue-text: var(--info-text);
  --color-status-yellow-background: var(--warning-subtle);
  --color-status-yellow-text: var(--warning-text);
  --color-status-orange-background: var(--warning-subtle);
  --color-status-orange-text: var(--warning-text);
  --color-status-rose-background: var(--error-subtle);
  --color-status-rose-text: var(--error-text);
  --color-ticket-detail-surface: var(--card);
  --color-ticket-detail-favorite: var(--warning);
  --color-ticket-detail-low-background: var(--info-subtle);
  --color-ticket-detail-low-text: var(--info-text);
  --color-ticket-detail-low-hover: var(--info-subtle);
  --color-ticket-detail-medium-hover: var(--warning-subtle);
  --color-ticket-detail-high-hover: var(--warning-subtle);
  --color-ticket-detail-urgent-hover: var(--error-subtle);
  --color-ticket-detail-resource-background: var(--info-subtle);
  --color-ticket-detail-resource-text: var(--info-text);
  --color-project-board-empty-panel: var(--surface);
  --color-project-board-empty-back: var(--muted);
  --color-project-board-empty-middle: var(--popover);
  --color-project-board-empty-front: var(--border);
  --color-project-board-empty-detail: var(--card);
  --color-background-full: var(--background);
  --color-background-primary-default: var(--card);
  --color-background-primary-hover: var(--surface);
  --color-background-primary-active: var(--popover);
  --color-background-secondary-default: var(--surface);
  --color-background-secondary-hover: var(--popover);
  --color-background-secondary-active: var(--accent);
  --color-background-tertiary-default: var(--popover);
  --color-background-tertiary-hover: var(--accent);
  --color-background-tertiary-active: var(--muted);
  --color-text-primary: var(--foreground);
  --color-text-white: #ffffff;
  --color-text-destructive: var(--error-text);
  --color-foreground-icon-primary: var(--foreground);
  --color-foreground-icon-secondary: var(--muted-foreground);
  --color-foreground-icon-tertiary: var(--muted-foreground);
  --color-border-button-default: var(--border);
  --color-border-button-white: var(--input);
  --color-border-focus-ring: var(--ring);
  --color-border-input-default: var(--input);
  --color-separator-border: var(--border);
  --color-button-primary: var(--primary);
  --color-dropdown-item-hover-background: var(--accent);
  --color-accent-50: var(--primary-subtle);
  --color-accent-100: var(--primary-subtle);
  --color-accent-200: var(--primary-subtle);
  --color-accent-300: var(--primary);
  --color-accent-400: var(--primary);
  --color-accent-500: var(--primary);
  --color-accent-600: var(--primary-text);
  --color-accent-700: var(--primary-text);
  --color-accent-800: var(--primary-text);
  --color-accent-900: var(--primary-text);
  --color-accent-950: var(--primary-text);
  --color-bg: var(--background);
  --color-fill: var(--card);
  --color-fill-secondary: var(--muted);
  --color-fill-hover: var(--accent);
  --color-fill-brand: var(--primary);
  --color-fill-brand-hover: var(--ring);
  --color-fill-inverse: var(--foreground);
  --color-fill-inverse-hover: var(--muted-foreground);
  --color-fill-placeholder: var(--muted);
  --color-text: var(--foreground);
  --color-text-secondary: var(--muted-foreground);
  --color-text-tertiary: var(--muted-foreground);
  --color-text-inverse: var(--primary-foreground);
  --color-text-fixed-light: var(--primary-foreground);
  --color-text-placeholder: var(--muted-foreground);
  --color-accent-primary: var(--primary-text);
  --color-accent-secondary: var(--secondary-text);
  --color-accent-tertiary: var(--tertiary-text);
  --color-border: var(--border);
  --color-border-image: var(--border);
  --color-border-secondary: var(--input);
  --color-border-input: var(--input);
  --color-border-input-active: var(--ring);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-surface: var(--surface);
  --color-surface-foreground: var(--surface-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-tertiary: var(--tertiary);
  --color-tertiary-foreground: var(--tertiary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-chart-6: var(--chart-6);
  --color-chart-7: var(--chart-7);
  --color-chart-8: var(--chart-8);
  --color-chart-9: var(--chart-9);
  --color-chart-1-active: var(--chart-1-active);
  --color-chart-2-active: var(--chart-2-active);
  --color-chart-3-active: var(--chart-3-active);
  --color-chart-4-active: var(--chart-4-active);
  --color-chart-5-active: var(--chart-5-active);
  --color-chart-6-active: var(--chart-6-active);
  --color-chart-7-active: var(--chart-7-active);
  --color-chart-8-active: var(--chart-8-active);
  --color-chart-9-active: var(--chart-9-active);
  --color-content-area: var(--content-area);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-primary-text: var(--primary-text);
  --color-primary-subtle: var(--primary-subtle);
  --color-secondary-text: var(--secondary-text);
  --color-secondary-subtle: var(--secondary-subtle);
  --color-tertiary-text: var(--tertiary-text);
  --color-tertiary-subtle: var(--tertiary-subtle);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-success-text: var(--success-text);
  --color-success-subtle: var(--success-subtle);
  --color-error: var(--error);
  --color-error-foreground: var(--error-foreground);
  --color-error-text: var(--error-text);
  --color-error-subtle: var(--error-subtle);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-text: var(--warning-text);
  --color-warning-subtle: var(--warning-subtle);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-info-text: var(--info-text);
  --color-info-subtle: var(--info-subtle);
  --color-destructive-foreground: #ffffff;
  --color-divider: var(--border);
  --spacing: 4px;
  --container-xs: 320px;
  --container-sm: 384px;
  --container-md: 448px;
  --container-lg: 512px;
  --container-xl: 576px;
  --spacing-space-2: 2px;
  --spacing-space-4: 4px;
  --spacing-space-8: 8px;
  --spacing-space-12: 12px;
  --spacing-space-16: 16px;
  --spacing-space-20: 20px;
  --spacing-space-24: 24px;
  --spacing-space-32: 32px;
  --spacing-space-40: 40px;
  --spacing-space-60: 60px;
  --spacing-screen-margin: 20px;
  --radius-radius-0: 0px;
  --radius-radius-2: 2px;
  --radius-radius-4: 4px;
  --radius-radius-8: 8px;
  --radius-radius-12: 12px;
  --radius-radius-16: 16px;
  --radius-radius-20: 20px;
  --radius-radius-24: 24px;
  --radius-radius-28: 28px;
  --radius-radius-max: 9999px;
  --border-width-hairline: 0.5px;
  --text-caption: 11px;
  --text-caption--line-height: calc(14 / 11);
  --text-caption--font-weight: 400;
  --font-caption: var(--bloom-font-sans);
  --text-bodySmall: 13px;
  --text-bodySmall--line-height: calc(18 / 13);
  --text-bodySmall--font-weight: 400;
  --font-bodySmall: var(--bloom-font-sans);
  --text-bodyTitleSmall: 13px;
  --text-bodyTitleSmall--line-height: calc(18 / 13);
  --text-bodyTitleSmall--font-weight: 600;
  --font-bodyTitleSmall: var(--bloom-font-sans);
  --text-body: 15px;
  --text-body--line-height: calc(22 / 15);
  --text-body--font-weight: 400;
  --font-body: var(--bloom-font-sans);
  --text-subtitle: 17px;
  --text-subtitle--line-height: calc(24 / 17);
  --text-subtitle--font-weight: 500;
  --font-subtitle: var(--bloom-font-sans);
  --text-sectionTitle: 20px;
  --text-sectionTitle--line-height: calc(26 / 20);
  --text-sectionTitle--font-weight: 600;
  --font-sectionTitle: var(--bloom-font-sans);
  --text-headerBold: 28px;
  --text-headerBold--line-height: calc(34 / 28);
  --text-headerBold--font-weight: 700;
  --font-headerBold: var(--bloom-font-display);
  --text-buttonLarge: 17px;
  --text-buttonLarge--line-height: calc(22 / 17);
  --text-buttonLarge--font-weight: 600;
  --font-buttonLarge: var(--bloom-font-sans);
  --text-large-title-regular: 64px;
  --text-large-title-regular--line-height: calc(80 / 64);
  --text-large-title-regular--font-weight: 400;
  --text-large-title-regular--letter-spacing: 0px;
  --text-large-title-medium: 64px;
  --text-large-title-medium--line-height: calc(80 / 64);
  --text-large-title-medium--font-weight: 500;
  --text-large-title-medium--letter-spacing: 0px;
  --text-large-title-semibold: 64px;
  --text-large-title-semibold--line-height: calc(80 / 64);
  --text-large-title-semibold--font-weight: 600;
  --text-large-title-semibold--letter-spacing: 0px;
  --text-large-title-bold: 64px;
  --text-large-title-bold--line-height: calc(80 / 64);
  --text-large-title-bold--font-weight: 700;
  --text-large-title-bold--letter-spacing: 0px;
  --text-display-1-regular: 56px;
  --text-display-1-regular--line-height: calc(72 / 56);
  --text-display-1-regular--font-weight: 400;
  --text-display-1-regular--letter-spacing: 0px;
  --text-display-1-medium: 56px;
  --text-display-1-medium--line-height: calc(72 / 56);
  --text-display-1-medium--font-weight: 500;
  --text-display-1-medium--letter-spacing: 0px;
  --text-display-1-semibold: 56px;
  --text-display-1-semibold--line-height: calc(72 / 56);
  --text-display-1-semibold--font-weight: 600;
  --text-display-1-semibold--letter-spacing: 0px;
  --text-display-1-bold: 56px;
  --text-display-1-bold--line-height: calc(72 / 56);
  --text-display-1-bold--font-weight: 700;
  --text-display-1-bold--letter-spacing: 0px;
  --text-display-2-regular: 48px;
  --text-display-2-regular--line-height: calc(64 / 48);
  --text-display-2-regular--font-weight: 400;
  --text-display-2-regular--letter-spacing: 0px;
  --text-display-2-medium: 48px;
  --text-display-2-medium--line-height: calc(64 / 48);
  --text-display-2-medium--font-weight: 500;
  --text-display-2-medium--letter-spacing: 0px;
  --text-display-2-semibold: 48px;
  --text-display-2-semibold--line-height: calc(64 / 48);
  --text-display-2-semibold--font-weight: 600;
  --text-display-2-semibold--letter-spacing: 0px;
  --text-display-2-bold: 48px;
  --text-display-2-bold--line-height: calc(64 / 48);
  --text-display-2-bold--font-weight: 700;
  --text-display-2-bold--letter-spacing: 0px;
  --text-display-3-regular: 40px;
  --text-display-3-regular--line-height: calc(54 / 40);
  --text-display-3-regular--font-weight: 400;
  --text-display-3-regular--letter-spacing: 0px;
  --text-display-3-medium: 40px;
  --text-display-3-medium--line-height: calc(54 / 40);
  --text-display-3-medium--font-weight: 500;
  --text-display-3-medium--letter-spacing: 0px;
  --text-display-3-semibold: 40px;
  --text-display-3-semibold--line-height: calc(54 / 40);
  --text-display-3-semibold--font-weight: 600;
  --text-display-3-semibold--letter-spacing: 0px;
  --text-display-3-bold: 40px;
  --text-display-3-bold--line-height: calc(54 / 40);
  --text-display-3-bold--font-weight: 700;
  --text-display-3-bold--letter-spacing: 0px;
  --text-display-4-regular: 32px;
  --text-display-4-regular--line-height: calc(44 / 32);
  --text-display-4-regular--font-weight: 400;
  --text-display-4-regular--letter-spacing: 0px;
  --text-display-4-medium: 32px;
  --text-display-4-medium--line-height: calc(44 / 32);
  --text-display-4-medium--font-weight: 500;
  --text-display-4-medium--letter-spacing: 0px;
  --text-display-4-semibold: 32px;
  --text-display-4-semibold--line-height: calc(44 / 32);
  --text-display-4-semibold--font-weight: 600;
  --text-display-4-semibold--letter-spacing: 0px;
  --text-display-4-bold: 32px;
  --text-display-4-bold--line-height: calc(44 / 32);
  --text-display-4-bold--font-weight: 700;
  --text-display-4-bold--letter-spacing: 0px;
  --text-title-1-regular: 24px;
  --text-title-1-regular--line-height: calc(34 / 24);
  --text-title-1-regular--font-weight: 400;
  --text-title-1-regular--letter-spacing: 0px;
  --text-title-1-medium: 24px;
  --text-title-1-medium--line-height: calc(34 / 24);
  --text-title-1-medium--font-weight: 500;
  --text-title-1-medium--letter-spacing: 0px;
  --text-title-1-semibold: 24px;
  --text-title-1-semibold--line-height: calc(34 / 24);
  --text-title-1-semibold--font-weight: 600;
  --text-title-1-semibold--letter-spacing: 0px;
  --text-title-1-bold: 24px;
  --text-title-1-bold--line-height: calc(34 / 24);
  --text-title-1-bold--font-weight: 700;
  --text-title-1-bold--letter-spacing: 0px;
  --text-title-2-regular: 20px;
  --text-title-2-regular--line-height: calc(26 / 20);
  --text-title-2-regular--font-weight: 400;
  --text-title-2-regular--letter-spacing: 0px;
  --text-title-2-medium: 20px;
  --text-title-2-medium--line-height: calc(26 / 20);
  --text-title-2-medium--font-weight: 500;
  --text-title-2-medium--letter-spacing: 0px;
  --text-title-2-semibold: 20px;
  --text-title-2-semibold--line-height: calc(26 / 20);
  --text-title-2-semibold--font-weight: 600;
  --text-title-2-semibold--letter-spacing: 0px;
  --text-title-2-bold: 20px;
  --text-title-2-bold--line-height: calc(26 / 20);
  --text-title-2-bold--font-weight: 700;
  --text-title-2-bold--letter-spacing: 0px;
  --text-title-3-regular: 18px;
  --text-title-3-regular--line-height: calc(24 / 18);
  --text-title-3-regular--font-weight: 400;
  --text-title-3-regular--letter-spacing: 0px;
  --text-title-3-medium: 18px;
  --text-title-3-medium--line-height: calc(26 / 18);
  --text-title-3-medium--font-weight: 500;
  --text-title-3-medium--letter-spacing: 0px;
  --text-title-3-semibold: 18px;
  --text-title-3-semibold--line-height: calc(26 / 18);
  --text-title-3-semibold--font-weight: 600;
  --text-title-3-semibold--letter-spacing: 0px;
  --text-title-3-bold: 18px;
  --text-title-3-bold--line-height: calc(26 / 18);
  --text-title-3-bold--font-weight: 700;
  --text-title-3-bold--letter-spacing: 0px;
  --text-headline-regular: 16px;
  --text-headline-regular--line-height: calc(22 / 16);
  --text-headline-regular--font-weight: 400;
  --text-headline-regular--letter-spacing: 0px;
  --text-headline-medium: 16px;
  --text-headline-medium--line-height: calc(22 / 16);
  --text-headline-medium--font-weight: 500;
  --text-headline-medium--letter-spacing: 0px;
  --text-headline-semibold: 16px;
  --text-headline-semibold--line-height: calc(22 / 16);
  --text-headline-semibold--font-weight: 600;
  --text-headline-semibold--letter-spacing: 0px;
  --text-headline-bold: 16px;
  --text-headline-bold--line-height: calc(22 / 16);
  --text-headline-bold--font-weight: 700;
  --text-headline-bold--letter-spacing: 0px;
  --text-body-regular: 14px;
  --text-body-regular--line-height: calc(20 / 14);
  --text-body-regular--font-weight: 400;
  --text-body-regular--letter-spacing: 0px;
  --text-body-medium: 14px;
  --text-body-medium--line-height: calc(20 / 14);
  --text-body-medium--font-weight: 500;
  --text-body-medium--letter-spacing: 0px;
  --text-body-semibold: 14px;
  --text-body-semibold--line-height: calc(20 / 14);
  --text-body-semibold--font-weight: 600;
  --text-body-semibold--letter-spacing: 0px;
  --text-body-bold: 14px;
  --text-body-bold--line-height: calc(20 / 14);
  --text-body-bold--font-weight: 700;
  --text-body-bold--letter-spacing: 0px;
  --text-body-2-regular: 13px;
  --text-body-2-regular--line-height: calc(18 / 13);
  --text-body-2-regular--font-weight: 400;
  --text-body-2-regular--letter-spacing: 0px;
  --text-body-2-medium: 13px;
  --text-body-2-medium--line-height: calc(18 / 13);
  --text-body-2-medium--font-weight: 500;
  --text-body-2-medium--letter-spacing: 0px;
  --text-body-2-semibold: 13px;
  --text-body-2-semibold--line-height: calc(18 / 13);
  --text-body-2-semibold--font-weight: 600;
  --text-body-2-semibold--letter-spacing: 0px;
  --text-body-2-bold: 13px;
  --text-body-2-bold--line-height: calc(18 / 13);
  --text-body-2-bold--font-weight: 700;
  --text-body-2-bold--letter-spacing: 0px;
  --text-caption-1-regular: 12px;
  --text-caption-1-regular--line-height: calc(16 / 12);
  --text-caption-1-regular--font-weight: 400;
  --text-caption-1-regular--letter-spacing: 0.15px;
  --text-caption-1-medium: 12px;
  --text-caption-1-medium--line-height: calc(16 / 12);
  --text-caption-1-medium--font-weight: 500;
  --text-caption-1-medium--letter-spacing: 0.15px;
  --text-caption-1-semibold: 12px;
  --text-caption-1-semibold--line-height: calc(16 / 12);
  --text-caption-1-semibold--font-weight: 600;
  --text-caption-1-semibold--letter-spacing: 0.15px;
  --text-caption-1-bold: 12px;
  --text-caption-1-bold--line-height: calc(16 / 12);
  --text-caption-1-bold--font-weight: 700;
  --text-caption-1-bold--letter-spacing: 0.15px;
  --text-caption-2-regular: 11px;
  --text-caption-2-regular--line-height: calc(15 / 11);
  --text-caption-2-regular--font-weight: 400;
  --text-caption-2-regular--letter-spacing: 0.2px;
  --text-caption-2-medium: 11px;
  --text-caption-2-medium--line-height: calc(15 / 11);
  --text-caption-2-medium--font-weight: 500;
  --text-caption-2-medium--letter-spacing: 0.2px;
  --text-caption-2-semibold: 11px;
  --text-caption-2-semibold--line-height: calc(15 / 11);
  --text-caption-2-semibold--font-weight: 600;
  --text-caption-2-semibold--letter-spacing: 0.2px;
  --text-caption-2-bold: 11px;
  --text-caption-2-bold--line-height: calc(15 / 11);
  --text-caption-2-bold--font-weight: 700;
  --text-caption-2-bold--letter-spacing: 0.2px;
  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 24px;
  --radius-4xl: 32px;
  --radius-2lg: 10px;
  --radius-2-5xl: 20px;
  --shadow-sidebar: 0 1px 0 0 rgb(0 0 0 / 0.0196), 0 1px 12px 0 rgb(0 0 0 / 0.0588), 0 0 1px 0 rgb(0 0 0 / 0.3216);
  --shadow-card: 0 1px 1px 0 rgb(0 0 0 / 0.05);
  --shadow-dropdown: 0 1px 1px 0 rgb(0 0 0 / 0.04), 0 4px 4px 0 rgb(0 0 0 / 0.02);
  --font-bloom-sans: var(--bloom-font-sans);
  --font-bloom-display: var(--bloom-font-display);
  --font-bloom-mono: var(--bloom-font-mono);
  --shadow-s: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10);
  --shadow-m: 0 4px 12px rgb(0 0 0 / 0.08), 0 2px 6px rgb(0 0 0 / 0.12);
}

```