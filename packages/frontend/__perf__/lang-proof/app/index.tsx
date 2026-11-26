/**
 * DEV ONLY: the proof page. `/?screen=ts&state=loaded` draws Settings ->
 * Notifications (`screen`: `ts`, the TypeScript original; `bloom` once the
 * port compiles) in a fixture branch (`state`: `pending`, `signedOut`,
 * `loading`, `loaded`), at a fixed width, for `../screenshot.mjs` to capture.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState, type ComponentType } from 'react';
import { View } from 'react-native';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

import TsScreen from '@/components/settings/pages/notifications';
import { setProofBranch, type ProofBranch } from '../fixture';

const SCREENS: Record<string, ComponentType> = { ts: TsScreen };
const BRANCHES: ProofBranch[] = ['pending', 'signedOut', 'loading', 'loaded'];

export default function ProofPage() {
  const params = useLocalSearchParams<{ screen?: string; state?: string }>();
  const Screen = SCREENS[params.screen ?? 'ts'];
  const branch = BRANCHES.find((name) => name === params.state) ?? 'loaded';
  // Once, before the screen first reads the fixture.
  useState(() => setProofBranch(branch));
  if (!Screen) return null;
  // The page behind is the app's dark splash colour; the frame paints the theme's own.
  return (
    <View style={{ width: 600 }}>
      {toElement(
        VStack(Embed(<Screen />))
          .padding('lg')
          .background('background')
          .testID('proof-frame'),
      )}
    </View>
  );
}
