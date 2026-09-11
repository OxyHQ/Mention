import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FabProps } from '@oxy.so/bloom/fab';

const bloomManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../node_modules/@oxy.so/bloom/package.json'), 'utf8'),
) as { version?: unknown };

// This is deliberately compiled against the installed package. A stale Bloom
// whose FabProps predates the collapse contract fails typecheck even if the
// Mention call site happens to contain the right-looking source text.
const inboxFabContract = {
  minimizeBehavior: 'collapse',
} satisfies Pick<FabProps, 'minimizeBehavior'>;

describe('home compose FAB', () => {
  const source = readFileSync(resolve(__dirname, '../app/(app)/(tabs)/index.tsx'), 'utf8');

  it('uses the same responsive Bloom contract as Inbox', () => {
    expect(bloomManifest.version).toBe('1.0.7');
    expect(inboxFabContract.minimizeBehavior).toBe('collapse');
    expect(source).toContain("label={Platform.OS === 'web'");
    expect(source).toContain('minimizeBehavior="collapse"');
  });
});
