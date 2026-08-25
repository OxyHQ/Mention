import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface HctColor {
  readonly hue: number;
  readonly chroma: number;
  readonly tone: number;
  toInt: () => number;
}

interface KotlinRole {
  day: string;
  night: string;
}

const BLOOM_ROOT = dirname(require.resolve('@oxyhq/bloom/package.json'));

// These are Bloom implementation modules rather than app runtime imports. The
// widget cannot execute JavaScript, so the test deliberately runs the installed
// package's exact generator and checks the committed Kotlin snapshot against it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { APP_COLOR_PRESETS, COLOR_PRESET_REGISTRY } = require(
  join(BLOOM_ROOT, 'lib/commonjs/theme/color-presets.js'),
) as {
  APP_COLOR_PRESETS: Record<string, { hex: string; variant: string; tertiaryHex?: string }>;
  COLOR_PRESET_REGISTRY: readonly unknown[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const engine = require(join(BLOOM_ROOT, 'lib/commonjs/theme/color-engine/index.js')) as {
  argbFromHex: (hex: string) => number;
  generateRoleColors: (input: {
    seed: string;
    variant: string;
    isDark: boolean;
  }) => Record<string, string>;
  hexFromArgb: (argb: number) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Hct } = require(join(BLOOM_ROOT, 'lib/commonjs/theme/color-engine/hct.js')) as {
  Hct: {
    from: (hue: number, chroma: number, tone: number) => HctColor;
    fromInt: (argb: number) => HctColor;
  };
};

const KOTLIN_THEME = join(
  __dirname,
  '..',
  'android',
  'src',
  'main',
  'java',
  'earth',
  'mention',
  'widgets',
  'theme',
  'MentionGlanceTheme.kt',
);

const ROLE_NAMES = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'error',
  'errorContainer',
  'onError',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'outline',
  'inverseOnSurface',
  'inverseSurface',
  'inversePrimary',
] as const;

function rgbRoleToKotlin(value: string): string {
  const channels = value.match(/^rgb\((\d+) (\d+) (\d+)\)$/);
  if (!channels) throw new Error(`Unexpected Bloom role color: ${value}`);
  return `0xFF${channels.slice(1).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function widgetBackground(secondaryContainer: string): string {
  const source = Hct.fromInt(engine.argbFromHex(`#${rgbRoleToKotlin(secondaryContainer).slice(4)}`));
  const tone = source.tone > 50 ? source.tone + 5 : source.tone - 10;
  return `0xFF${engine.hexFromArgb(Hct.from(source.hue, source.chroma, tone).toInt()).slice(1).toUpperCase()}`;
}

function expectedRoles(): Record<string, KotlinRole> {
  const preset = APP_COLOR_PRESETS.blue;
  const light = engine.generateRoleColors({ seed: preset.hex, variant: preset.variant, isDark: false });
  const dark = engine.generateRoleColors({ seed: preset.hex, variant: preset.variant, isDark: true });
  const roles = Object.fromEntries(
    ROLE_NAMES.map((name) => [name, { day: rgbRoleToKotlin(light[name]), night: rgbRoleToKotlin(dark[name]) }]),
  );
  roles.widgetBackground = {
    day: widgetBackground(light.secondaryContainer),
    night: widgetBackground(dark.secondaryContainer),
  };
  return roles;
}

function kotlinRoles(): Record<string, KotlinRole> {
  const source = readFileSync(KOTLIN_THEME, 'utf8');
  const roles: Record<string, KotlinRole> = {};
  const provider = /(\w+)\s*=\s*ColorProvider\(day\s*=\s*Color\((0x[0-9A-F]+)\),\s*night\s*=\s*Color\((0x[0-9A-F]+)\)\)/g;
  for (const match of source.matchAll(provider)) {
    roles[match[1]] = { day: match[2], night: match[3] };
  }
  return roles;
}

describe('Mention widget Bloom theme parity', () => {
  it('loads the expanded dynamic registry from the installed release', () => {
    expect(COLOR_PRESET_REGISTRY).toHaveLength(64);
    expect(APP_COLOR_PRESETS.cobalt.tertiaryHex).toBe('#ffd000');
  });

  it('pins every pre-Android-12 Glance role to the installed blue policy', () => {
    const expected = expectedRoles();
    const actual = kotlinRoles();

    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    expect(actual).toEqual(expected);

    // Positive control: a stale role from any prior policy must make parity red.
    expect({ ...actual, primary: { ...actual.primary, night: '0xFF000000' } }).not.toEqual(expected);
  });
});
