import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FabProps } from '@oxy.so/bloom/fab';

const bloomManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../node_modules/@oxy.so/bloom/package.json'), 'utf8'),
) as { version?: unknown };
const bloomWebFabArtifact = readFileSync(
  resolve(__dirname, '../../../node_modules/@oxy.so/bloom/lib/module/fab/Fab.web.js'),
  'utf8',
);

// This is deliberately compiled against the installed package. A stale Bloom
// whose FabProps predates the collapse contract fails typecheck even if the
// Mention call site happens to contain the right-looking source text.
const inboxFabContract = {
  minimizeBehavior: 'collapse',
} satisfies Pick<FabProps, 'minimizeBehavior'>;

describe('home compose FAB', () => {
  const source = readFileSync(resolve(__dirname, '../app/(app)/(tabs)/index.tsx'), 'utf8');

  it('uses the same responsive Bloom contract as Inbox', () => {
    expect(bloomManifest.version).toBe('1.0.8');
    expect(inboxFabContract.minimizeBehavior).toBe('collapse');
    expect(source).toContain("label={Platform.OS === 'web'");
    expect(source).toContain('minimizeBehavior="collapse"');
  });

  it('installs the document-scroll-aware web FAB artifact', () => {
    expect(bloomWebFabArtifact).toContain("position: isBottom ? 'sticky' : 'absolute'");
    expect(bloomWebFabArtifact).toContain("style.marginTop = 'auto'");
    expect(bloomWebFabArtifact).toContain("style.alignSelf = 'flex-end'");
  });
});
