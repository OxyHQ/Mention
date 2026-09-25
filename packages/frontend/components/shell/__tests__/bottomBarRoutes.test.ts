import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hidesBottomBar } from '../bottomBarRoutes';

/**
 * The Alia chat's text input sat under the shell's bottom tab bar and its
 * compose FAB (#1140). A full-screen conversation gets no bar.
 */
describe('hidesBottomBar', () => {
  it.each(['/ai', '/ai/', '/ai/thread-1'])('hides the bar on the chat route %s', (pathname) => {
    expect(hidesBottomBar(pathname)).toBe(true);
  });

  it.each(['/', '/videos', '/notifications', '/you', '/aid', '/@ai', undefined, null, ''])(
    'keeps the bar on %p',
    (pathname) => {
      expect(hidesBottomBar(pathname)).toBe(false);
    },
  );

  it('is what the app shell consults before drawing the bar', () => {
    const layout = readFileSync(join(__dirname, '..', '..', '..', 'app', '(app)', '_layout.tsx'), 'utf8');
    expect(layout).toMatch(/bottomBar=\{[^}]*!hidesBottomBar\(pathname\)[^}]*<BottomBar \/>/);
  });
});
