import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverlayInertBoundaryProps } from '@oxy.so/bloom/portal';

/**
 * Screen readers stay inside an open modal (#1126 item 7).
 *
 * Bloom's modal surfaces render at `<PortalOutlet />`, the app content's
 * sibling. Android's TalkBack can only be kept out of the content by a view
 * that WRAPS the content, so the root layout wraps `<AuthRouter />` — and only
 * it — in Bloom's `OverlayInertBoundary`. Wrapping the outlet (or the media
 * flight layer) would hide the very surfaces that are open.
 */

// Compiled against the installed Bloom: a version without the boundary fails
// typecheck here rather than at runtime.
const boundaryProps: OverlayInertBoundaryProps = { testID: 'app-content' };

describe('root layout modal inert boundary', () => {
  const source = readFileSync(resolve(__dirname, '../app/_layout.tsx'), 'utf8');
  const jsx = source.slice(source.indexOf('<PortalProvider>'), source.indexOf('</PortalProvider>'));

  it('wraps the app content, and only the app content', () => {
    expect(boundaryProps.testID).toBe('app-content');
    expect(source).toMatch(
      /import \{[^}]*\bOverlayInertBoundary\b[^}]*\} from '@oxy\.so\/bloom\/portal'/,
    );
    const open = jsx.indexOf('<OverlayInertBoundary>');
    const close = jsx.indexOf('</OverlayInertBoundary>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);

    const inside = jsx.slice(open, close);
    expect(inside).toContain('<AuthRouter />');
    expect(inside).not.toContain('<PortalOutlet');
    expect(inside).not.toContain('<MediaFlightLayer');

    const outside = jsx.slice(close);
    expect(outside).toContain('<PortalOutlet />');
    expect(outside).toContain('<MediaFlightLayer />');
  });
});
