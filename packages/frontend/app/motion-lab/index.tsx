// LOCAL MEASUREMENT FIXTURE — never committed. Touches no account data: the like
// is local state, the toast is a local toast, the sheet holds static text.
import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import { Button } from '@oxy.so/bloom/button';
import { EngagementAction, EngagementBar } from '@oxy.so/bloom/engagement-bar';
import { BottomSheet, type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import { toast } from '@oxy.so/bloom/toast';
import { LikeIcon } from '@oxy.so/bloom/icons/LikeIcon';
import { LikeFillIcon } from '@oxy.so/bloom/icons/LikeFillIcon';

declare const HermesInternal:
  | { enableSamplingProfiler?: () => void; disableSamplingProfiler?: () => void; dumpSampledTraceToFile?: (path: string) => void }
  | undefined;

function Profiler() {
  const [state, setState] = useState(
    typeof HermesInternal?.enableSamplingProfiler === 'function' ? 'Profile start' : 'No profiler',
  );
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button
        accessibilityLabel="Profile start"
        onPress={() => {
          HermesInternal?.enableSamplingProfiler?.();
          setState('Profiling');
        }}
      >
        {state}
      </Button>
      <Button
        accessibilityLabel="Profile dump"
        onPress={() => {
          const file = new File(Paths.cache, 'motion.cpuprofile');
          HermesInternal?.dumpSampledTraceToFile?.(file.uri.replace('file://', ''));
          HermesInternal?.disableSamplingProfiler?.();
          // To the host, through `adb reverse tcp:8099 tcp:8099`.
          fetch('http://localhost:8099/profile', { method: 'POST', body: file.textSync() })
            .then(() => setState('Sent'))
            .catch((error) => setState(`Send failed ${String(error)}`));
        }}
      >
        Profile dump
      </Button>
    </View>
  );
}

function LikeDemo() {
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(41);
  return (
    <EngagementBar>
      <EngagementAction
        icon={LikeIcon}
        activeIcon={LikeFillIcon}
        accessibilityLabel="Like"
        active={liked}
        tone="error"
        popOnActivate
        rollCount
        count={count}
        onPress={() => {
          setLiked((was) => !was);
          setCount((was) => (liked ? was - 1 : was + 1));
        }}
      />
    </EngagementBar>
  );
}

function SheetDemo() {
  const sheet = useRef<BottomSheetRef>(null);
  return (
    <>
      <Button accessibilityLabel="Open sheet" onPress={() => sheet.current?.present()}>
        Open sheet
      </Button>
      <BottomSheet ref={sheet} accessibilityLabel="Lab sheet">
        <ScrollView>
          <View style={{ padding: 24, gap: 12 }}>
            <Text accessibilityLabel="Sheet body">Sheet body</Text>
            {Array.from({ length: 12 }, (_, i) => (
              <Text key={i}>Line {i + 1}</Text>
            ))}
          </View>
        </ScrollView>
      </BottomSheet>
    </>
  );
}

export default function MotionLab() {
  const { demo = 'like' } = useLocalSearchParams<{ demo?: string }>();
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 120, gap: 24 }}>
      <Text>{`Motion lab: ${demo}`}</Text>
      <Profiler />
      {demo === 'like' && <LikeDemo />}
      {demo === 'toast' && (
        <Button accessibilityLabel="Show toast" onPress={() => toast('Saved to bookmarks')}>
          Show toast
        </Button>
      )}
      {demo === 'sheet' && <SheetDemo />}
    </View>
  );
}
