import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..');

function source(...segments: string[]): string {
  return readFileSync(join(FRONTEND, ...segments), 'utf8');
}

function styleBody(file: string, name: string): string {
  const match = file.match(new RegExp(`${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`));
  if (!match) throw new Error(`Missing ${name} style`);
  return match[1];
}

describe('dynamic theme surfaces', () => {
  it('does not let inline compose-mode colors override light/dark theme roles', () => {
    // TWO sources, because this case has two subjects and they no longer share a
    // file: the theme roles are applied in the component's JSX, while the style
    // objects they must not be overridden by live in the composer's stylesheet
    // module. Reading the component for both was correct only while the
    // stylesheet sat at the bottom of it.
    const file = source('components', 'Compose', 'ComposeScreen.tsx');
    const stylesFile = source('components', 'Compose', 'ComposeScreen.styles.ts');
    const modeLabel = styleBody(stylesFile, 'modeLabel');
    const modeDescription = styleBody(stylesFile, 'modeDescription');

    // The colours are Bloom's theme roles (`useColorTokens`), set before the
    // style objects so nothing in the stylesheet can override them.
    expect(file).toMatch(
      /postingMode === 'thread'\s*\?\s*colorTokens\.primary\s*:\s*colorTokens\.foreground/,
    );
    expect(file).toMatch(
      /postingMode === 'beast'\s*\?\s*colorTokens\.primary\s*:\s*colorTokens\.foreground/,
    );
    expect(file).toContain(
      'style={[{ color: colorTokens.mutedForeground }, styles.modeDescription]}',
    );
    expect(modeLabel).not.toMatch(/\bcolor\s*:/);
    expect(modeDescription).not.toMatch(/\bcolor\s*:/);

    // Positive control: this is the exact inline shape that would win over the
    // theme role on both light and dark render paths.
    expect("fontSize: 16, color: '#005c67'").toMatch(/\bcolor\s*:/);
  });
});
