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

/** The JSX between the keyboard-avoiding view's open and close tags. */
function keyboardAvoidingBody(): string {
  const open = screen.indexOf('<KeyboardAvoidingView');
  const close = screen.indexOf('</KeyboardAvoidingView>');
  if (open < 0 || close < open) throw new Error('No KeyboardAvoidingView in ComposeScreen');
  return screen.slice(open, close);
}

describe('the composer footer', () => {
  it('avoids the keyboard with keyboard-controller’s view, on every platform', () => {
    // Under `KeyboardProvider` Android is edge-to-edge and the window is never
    // resized; React Native's view with no behaviour (Android's old branch) did
    // nothing, and the Post button stayed behind the keyboard.
    expect(screen).toMatch(/import \{ KeyboardAvoidingView \} from 'react-native-keyboard-controller';/);
    expect(screen).not.toMatch(/\bKeyboardAvoidingView,\s*\n[^}]*\} from 'react-native';/);
    const open = screen.slice(screen.indexOf('<KeyboardAvoidingView'), screen.indexOf('>', screen.indexOf('<KeyboardAvoidingView')));
    expect(open).toContain('behavior="padding"');
    expect(open).not.toContain('Platform.OS');
  });

  it('puts the Post button INSIDE the keyboard-avoiding view, in the footer row', () => {
    // It used to float outside it, absolutely positioned — behind the keyboard,
    // and over the last pill once the keyboard was down.
    const body = keyboardAvoidingBody();
    expect(body).toContain('testID="compose-submit"');
    expect(body).toContain('<ChipRow');
    expect(body.indexOf('<ChipRow')).toBeLessThan(body.indexOf('testID="compose-submit"'));
    expect(screen).not.toContain('floatingPostButton');
  });

  it('gives the pills the width the button leaves, and never overlaps them', () => {
    expect(styleBody('bottomBar')).toMatch(/flexDirection: 'row'/);
    expect(styleBody('bottomBar')).not.toMatch(/position: 'absolute'/);
    expect(styleBody('bottomBarChips')).toMatch(/flex: 1/);
    expect(styleBody('bottomBarSubmit')).toMatch(/flexShrink: 0/);
  });

  it('clears the bottom safe area itself, since the shell bar is never drawn over it', () => {
    expect(screen).toContain("edges={['top', 'bottom']}");
    // The old per-screen guesses at the shell bar's height are gone.
    expect(screen).not.toMatch(/bottomBarVisible/);
  });
});

describe('the composer header', () => {
  it('gives the composer TAB a close control, not just the pushed composer', () => {
    // "New post" (the tab) had no way out; "Reply" (pushed) had a back arrow.
    const header = screen.slice(screen.indexOf('{/* Header */}'), screen.indexOf('styles.headerTitle'));
    expect(header).toMatch(/presentation === 'tab' \?/);
    expect(header).toContain('leadingIcon={RiCloseLine}');
    expect(header).toContain('testID="compose-close"');
    expect(header).toContain('leadingIcon={RiArrowLeftLine}');
    expect(header).not.toMatch(/\) : null\}\s*$/);
  });
});
