import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The composer's footer — schedule, language, audience, CW, and the Post button —
 * as the device QA of OxyHQ/Mention#1140 found it, and what keeps it fixed.
 *
 * `ComposeScreen` is a 3,700-line screen over a dozen providers, so these read
 * its source the way `styles/__tests__/dynamicThemeSurfaces.test.ts` does. Each
 * case names the defect it pins and fails on the shape that caused it.
 */
const COMPOSE = join(__dirname, '..');
const screen = readFileSync(join(COMPOSE, 'ComposeScreen.tsx'), 'utf8');
const styles = readFileSync(join(COMPOSE, 'ComposeScreen.styles.ts'), 'utf8');

function styleBody(name: string): string {
  const match = styles.match(new RegExp(`\\n  ${name}:\\s*\\{([\\s\\S]*?)\\n  \\},`));
  if (!match) throw new Error(`Missing ${name} style`);
  return match[1];
}

/** The JSX handed to the Screen as its bottom bar. */
function bottomBar(): string {
  const open = screen.indexOf('bottomBar={');
  const close = screen.indexOf('</PageFooter>', open);
  if (open < 0 || close < open) throw new Error('No Screen bottomBar in ComposeScreen');
  return screen.slice(open, close);
}

describe('the composer footer', () => {
  it('rides on the keyboard as the Screen’s bottom bar', () => {
    // A KeyboardAvoidingView sized itself from the window height, which a race at
    // boot left short by the status bar: the Post button sat behind the keyboard.
    // Bloom's footer follows the keyboard height alone.
    expect(screen).toContain('bottomBarKeyboardBehavior="follow"');
    expect(screen).not.toContain('KeyboardAvoidingView');
  });

  it('puts the Post button in the footer row, after the pills', () => {
    // It used to float outside the footer, absolutely positioned — behind the
    // keyboard, and over the last pill once the keyboard was down.
    const footer = bottomBar();
    expect(footer).toContain('testID="compose-submit"');
    expect(footer).toContain('<ChipRow');
    expect(footer.indexOf('<ChipRow')).toBeLessThan(footer.indexOf('testID="compose-submit"'));
    expect(screen).not.toContain('floatingPostButton');
  });

  it('gives the pills the width the button leaves, and never overlaps them', () => {
    expect(styleBody('bottomBar')).toMatch(/flexDirection: 'row'/);
    expect(styleBody('bottomBar')).not.toMatch(/position: 'absolute'/);
    expect(styleBody('bottomBarChips')).toMatch(/flex: 1/);
    expect(styleBody('bottomBarSubmit')).toMatch(/flexShrink: 0/);
  });
});

describe('the composer header', () => {
  it('gives the composer TAB a close control, and the pushed composer Back', () => {
    // "New post" (the tab) had no way out; "Reply" (pushed) has Bloom's Back,
    // which asks before an unsent draft is left.
    const header = screen.slice(screen.indexOf('<PageHeader'), screen.indexOf('actions={'));
    expect(header).toMatch(/presentation === 'tab'/);
    expect(header).toContain('leadingIcon={RiCloseLine}');
    expect(header).toContain('testID="compose-close"');
    expect(header).toContain('discardControl.open()');
  });
});
