/**
 * DEV ONLY: the proof page. `/?screen=original&state=loaded` draws Settings ->
 * Notifications (`screen`: `original`, `cleaned` or `bloom`, `../screens.tsx`)
 * in a fixture branch (`state`: `pending`, `signedOut`, `loading`, `loaded`), at
 * a fixed width, for `../screenshot.mjs` to capture. `/?row=PostLaneChip&state=tab&form=ts`
 * draws one of PostItem's rows in one of its states (`../rows/states.json`), in
 * its TypeScript (`ts`) or `.bloom` (`bloom`) form, as PostItem draws it.
 * `/?post=quote&form=bloom` draws PostItem itself on a feed fixture
 * (`../postitem/posts.tsx`), in either form, as a feed row.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

import { setProofBranch, type ProofBranch } from '../fixture';
import { ROW_FORMS, ROW_STATES, drawRow, rowProps } from '../rows/rows';
import { POST_FORMS, POST_KINDS, drawPost, proofPost } from '../postitem/posts';
import { PROOF_SCREENS, loadScreen } from '../screens';
import { usePostsStore } from '@/stores/postsStore';
import { VideoPlaybackProvider, VideoViewabilityProvider } from '@oxy.so/bloom/video-playback';

/** Nothing on screen as viewable: a video row draws its poster, as the row-cost harness measures it. */
const NO_VIEWABLE_KEYS: ReadonlySet<string> = new Set();

const BRANCHES: ProofBranch[] = ['pending', 'signedOut', 'loading', 'loaded'];

export default function ProofPage() {
  const params = useLocalSearchParams<{
    screen?: string;
    state?: string;
    row?: string;
    form?: string;
    post?: string;
  }>();
  if (params.post) return <PostPage kind={params.post} form={params.form} />;
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

function PostPage(params: { kind: string; form?: string }) {
  const kind = POST_KINDS.find((k) => k === params.kind);
  const form = POST_FORMS.find((f) => f === params.form) ?? 'ts';
  // The row reads its post from the posts store, as a feed row does once the page is cached.
  const [post] = useState(() => {
    if (!kind) return null;
    const made = proofPost(kind);
    usePostsStore.getState().cachePosts([made]);
    return made;
  });
  if (!post) return null;
  return (
    <VideoPlaybackProvider>
      <VideoViewabilityProvider viewableKeys={NO_VIEWABLE_KEYS}>
        <View style={{ width: 600 }}>
          {toElement(
            VStack(Embed(drawPost(form, post)))
              .background('background')
              .testID('proof-frame'),
          )}
        </View>
      </VideoViewabilityProvider>
    </VideoPlaybackProvider>
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
