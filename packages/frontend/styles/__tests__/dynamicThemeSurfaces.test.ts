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
  it('keeps the notification permission surface on Bloom roles in every mode', () => {
    const file = source('components', 'NotificationPermissionSheet.tsx');

    expect(file).toContain("from '@oxyhq/bloom/button'");
    expect(file).toContain('text-foreground');
    expect(file).toContain('text-muted-foreground');
    expect(file).toContain('variant="primary"');
    expect(file).toContain('variant="secondary"');
    expect(file).not.toContain('@/styles/colors');
    expect(file).not.toMatch(/#[0-9a-f]{3,8}\b/i);

    // Positive control: the literal detector must fire on the regression shape.
    expect("color: '#005c67'").toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('does not let inline compose-mode colors override light/dark theme roles', () => {
    const file = source('app', '(app)', 'compose.tsx');
    const modeLabel = styleBody(file, 'modeLabel');
    const modeDescription = styleBody(file, 'modeDescription');

    expect(file).toContain("postingMode === 'thread' ? 'text-primary' : 'text-foreground'");
    expect(file).toContain("postingMode === 'beast' ? 'text-primary' : 'text-foreground'");
    expect(file).toContain('className="text-muted-foreground" style={styles.modeDescription}');
    expect(modeLabel).not.toMatch(/\bcolor\s*:/);
    expect(modeDescription).not.toMatch(/\bcolor\s*:/);

    // Positive control: this is the exact inline shape that would win over the
    // class token on both light and dark render paths.
    expect("fontSize: 16, color: '#005c67'").toMatch(/\bcolor\s*:/);
  });
});
