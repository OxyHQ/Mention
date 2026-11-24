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

/** The footer's language row, from its ChipRow to the end of the screen's stack. */
function footerRow(): string {
  const body = keyboardAvoidingBody();
  return body.slice(body.lastIndexOf('HStack(', body.indexOf('<ChipRow')));
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
    expect(screen).toMatch(
      /import \{ KeyboardAvoidingView \} from 'react-native-keyboard-controller';/,
    );
    expect(screen).not.toMatch(/\bKeyboardAvoidingView,\s*\n[^}]*\} from 'react-native';/);
    const open = screen.slice(
      screen.indexOf('<KeyboardAvoidingView'),
      screen.indexOf('>', screen.indexOf('<KeyboardAvoidingView')),
    );
    expect(open).toContain('behavior="padding"');
    expect(open).not.toContain('Platform.OS');
  });

  it('puts the Post button INSIDE the keyboard-avoiding view, in the footer row', () => {
    // It used to float outside it, absolutely positioned — behind the keyboard,
    // and over the last pill once the keyboard was down.
    const body = keyboardAvoidingBody();
    // The button is a language chain inside the view: `.testID('compose-submit')`.
    expect(body).toContain(".testID('compose-submit')");
    expect(body).toContain('<ChipRow');
    expect(body.indexOf('<ChipRow')).toBeLessThan(body.indexOf(".testID('compose-submit')"));
    expect(screen).not.toContain('floatingPostButton');
  });

  it('gives the pills the width the button leaves, and never overlaps them', () => {
    // The footer is one row (`HStack`), never pinned over the pills; the submit
    // slot, the stack holding the Post button, never shrinks.
    const footer = footerRow();
    expect(footer).toMatch(/^HStack\(/);
    expect(footer).not.toContain('.position(');
    expect(styleBody('bottomBarChips')).toMatch(/flex: 1/);
    const submitSlot = footer.slice(footer.indexOf(".testID('compose-submit')"));
    expect(submitSlot).toMatch(
      /^\.testID\('compose-submit'\),\s*\)\s*\.align\('center'\)\s*\.spacing\('sm'\)\s*\.shrink\('never'\)/,
    );
  });

  it('clears the bottom safe area itself, since the shell bar is never drawn over it', () => {
    // The root pads itself by the device's insets, top and bottom: the language's
    // safe-area padding on the root stack, painted by the fill chained after it.
    const root = screen.slice(screen.indexOf('</KeyboardAvoidingView>'));
    expect(root).toMatch(/\.safeAreaPadding\('vertical'\)\s*\.background\('card'\)/);
    // The old per-screen guesses at the shell bar's height are gone.
    expect(screen).not.toMatch(/bottomBarVisible/);
  });
});

describe('the composer header', () => {
  it('is Bloom’s header: the tab closes with an X, the pushed composer goes back', () => {
    // "New post" (the tab) had no way out; "Reply" (pushed) had a back arrow. The header is
    // Bloom's floating header (the language's `Header`), so its controls are the floating glass
    // and its title has the room the header gives it, at the start (centred, it was cut off).
    const header = screen.slice(
      screen.indexOf('/* Header'),
      screen.indexOf('.inPage()', screen.indexOf('/* Header')),
    );
    expect(header).toContain('Header(');
    expect(header).toMatch(/presentation === 'tab'\s*\?/);
    expect(header).toContain('LButton(Icon(RiCloseLine))');
    expect(header).toContain(".testID('compose-close')");
    expect(header).toContain('.onBack(');
    expect(header).toContain('ButtonGroup(');
    expect(header).not.toContain(".titleAlign('center')");
  });
});
