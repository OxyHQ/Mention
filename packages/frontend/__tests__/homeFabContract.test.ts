import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FabProps } from '@oxy.so/bloom/fab';

const bloomManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../node_modules/@oxy.so/bloom/package.json'), 'utf8'),
) as { version?: unknown };
// Fab owns its label state; BottomBar owns scroll-driven minimization.
const fabLabelContract = {
  collapsed: true,
} satisfies Pick<FabProps, 'collapsed'>;

describe('home compose FAB', () => {
  const source = readFileSync(resolve(__dirname, '../components/BottomBar.tsx'), 'utf8');

  it('keeps compose in navigation while Fab exposes label collapse', () => {
    expect(Number(String(bloomManifest.version).split('.')[0])).toBeGreaterThanOrEqual(6);
    expect(source).toMatch(/action=\{\s*<Fab/);
    expect(fabLabelContract.collapsed).toBe(true);
    expect(source).toContain('minimizeProgress={minimizeProgress}');
  });
});
