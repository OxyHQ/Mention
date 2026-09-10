import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('BottomBar icon colors', () => {
  it('uses foreground for the active glyph and reserves primary for the selection indicator', () => {
    const source = readFileSync(resolve(__dirname, '../../BottomBar.tsx'), 'utf8');

    expect(source).toContain("isVideosScreen ? 'text-white' : 'text-foreground'");
    expect(source).not.toContain("isVideosScreen ? 'text-white' : 'text-primary'");
  });
});
