/**
 * DEV ONLY: the proof page. `/?screen=original&state=loaded` draws Settings ->
 * Notifications (`screen`: `original`, `cleaned` or `bloom`, `../screens.tsx`)
 * in a fixture branch (`state`: `pending`, `signedOut`, `loading`, `loaded`), at
 * a fixed width, for `../screenshot.mjs` to capture. `/?row=PostLaneChip&state=tab&form=ts`
 * draws one of PostItem's rows in one of its states (`../rows/states.json`), in
 * its TypeScript (`ts`) or `.bloom` (`bloom`) form, as PostItem draws it.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

import { setProofBranch, type ProofBranch } from '../fixture';
import { ROW_FORMS, ROW_STATES, drawRow, rowProps } from '../rows/rows';
import { PROOF_SCREENS, loadScreen } from '../screens';

const BRANCHES: ProofBranch[] = ['pending', 'signedOut', 'loading', 'loaded'];

export default function ProofPage() {
  const params = useLocalSearchParams<{
    screen?: string;
    state?: string;
    row?: string;
    form?: string;
  }>();
  if (params.row) return <RowPage row={params.row} state={params.state} form={params.form} />;
  return <ScreenPage screen={params.screen} state={params.state} />;
}

function RowPage(params: { row: string; state?: string; form?: string }) {
  const state = ROW_STATES.find((s) => s.row === params.row && s.state === params.state);
  const form = ROW_FORMS.find((f) => f === params.form) ?? 'ts';
  if (!state) return null;
  return (
    <View style={{ width: 600 }}>
      {toElement(
        VStack(drawRow(form, state.row, rowProps(state)))
          .padding('lg')
          .background('background')
          .testID('proof-frame'),
      )}
    </View>
  );
}

function ScreenPage(params: { screen?: string; state?: string }) {
  const screen = PROOF_SCREENS.find((name) => name === params.screen);
  const branch = BRANCHES.find((name) => name === params.state) ?? 'loaded';
  // Once, before the screen first reads the fixture; the screen's module once.
  useState(() => setProofBranch(branch));
  const [drawScreen] = useState(() => (screen ? loadScreen(screen) : null));
  if (!drawScreen) return null;
  // The page behind is the app's dark splash colour; the frame paints the theme's own.
  return (
    <View style={{ width: 600 }}>
      {toElement(
        VStack(Embed(drawScreen())).padding('lg').background('background').testID('proof-frame'),
      )}
    </View>
  );
}
