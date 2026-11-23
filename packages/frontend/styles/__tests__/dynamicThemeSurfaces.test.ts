import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..');

function source(...segments: string[]): string {
  return readFileSync(join(FRONTEND, ...segments), 'utf8');
}

/** The body of a module-level function, up to its closing brace at column 0. */
function functionBody(file: string, name: string): string {
  const match = file.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[0];
}

describe('dynamic theme surfaces', () => {
  it('does not let inline compose-mode colors override light/dark theme roles', () => {
    // The posting modes' names and descriptions are language text inked with
    // Bloom's colour roles, which follow the theme; nothing in the option sets a
    // raw colour that would win over them.
    const file = source('components', 'Compose', 'ComposeScreen.tsx');
    const modeOption = functionBody(file, 'modeOption');

    expect(modeOption).toContain(".foreground(active ? 'primary' : 'foreground')");
    expect(modeOption).toContain(".foreground('muted')");
    expect(modeOption).not.toMatch(/\bcolor\s*:/);
    expect(modeOption).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(file).toMatch(/modeOption\(\s*postingMode === 'thread',/);
    expect(file).toMatch(/modeOption\(\s*postingMode === 'beast',/);

    // Positive control: this is the exact inline shape that would win over the
    // theme role on both light and dark render paths.
    expect("fontSize: 16, color: '#005c67'").toMatch(/\bcolor\s*:/);
  });
});
