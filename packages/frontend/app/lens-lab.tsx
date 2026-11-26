// LOCAL ONLY (uncommitted): a lab screen for the lens engine's glass groups (members, blend, union, key morph).
import { LensBase, type LensGroupMember } from '@oxy.so/bloom-lens';
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

const STRIPES = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#9b5de5'];
const SIZE = 52;

function Dot({ id, wide }: { id?: string; wide?: boolean }) {
  return (
    <View
      nativeID={id}
      collapsable={false}
      style={{ width: wide ? SIZE * 2 : SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: 'white', fontWeight: '700' }}>{id ? id.replace('lab-', '') : ''}</Text>
    </View>
  );
}

function Control({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'black', borderRadius: 8 }}
    >
      <Text style={{ color: 'white' }}>{label}</Text>
    </Pressable>
  );
}

function Scene({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontWeight: '700', color: 'black' }}>{title}</Text>
      {children}
    </View>
  );
}

const GAPS = [4, 14, 30];
const m = (key: string, extra?: Partial<LensGroupMember>): LensGroupMember => ({ key, ...extra });

export default function LensLab() {
  const [gap, setGap] = useState(0);
  const [selected, setSelected] = useState(0);
  const [third, setThird] = useState(false);
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingHorizontal: 20, gap: 22 }}>
      <View style={{ position: 'absolute', inset: 0, flexDirection: 'row' }} pointerEvents="none">
        {STRIPES.map((color) => (
          <View key={color} style={{ flex: 1, backgroundColor: color, opacity: 0.6 }} />
        ))}
      </View>
      <Scene title={`Blend 24 at rest, gap ${GAPS[gap]}`}>
        <LensBase blend={24} members={[m('lab-a'), m('lab-b'), m('lab-c')]} style={{ alignSelf: 'flex-start' }}>
          <View style={{ flexDirection: 'row', gap: GAPS[gap] }}>
            <Dot id="lab-a" />
            <Dot id="lab-b" />
            <Dot id="lab-c" />
          </View>
        </LensBase>
      </Scene>
      <Scene title="Union: the first two are one shape">
        <LensBase blend={0} members={[m('lab-u'), m('lab-d')]} style={{ alignSelf: 'flex-start' }}>
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <Dot id="lab-u" />
            <Dot id="lab-u" />
            <Dot id="lab-d" />
          </View>
        </LensBase>
      </Scene>
      <Scene title={`A key moves: selected ${selected}`}>
        <LensBase blend={16} members={[m('lab-sel')]} style={{ alignSelf: 'flex-start' }}>
          <View style={{ flexDirection: 'row', gap: 40 }}>
            {[0, 1, 2].map((slot) => (
              <Dot key={slot} id={slot === selected ? 'lab-sel' : undefined} />
            ))}
          </View>
        </LensBase>
      </Scene>
      <Scene title={`Arrive and leave: third ${third ? 'on' : 'off'}`}>
        <LensBase
          blend={24}
          members={[m('lab-p'), m('lab-q'), ...(third ? [m('lab-r')] : [])]}
          style={{ alignSelf: 'flex-start' }}
        >
          <View style={{ flexDirection: 'row', gap: 24 }}>
            <Dot id="lab-p" />
            <Dot id="lab-q" />
            {third ? <Dot id="lab-r" /> : <View style={{ width: SIZE, height: SIZE }} />}
          </View>
        </LensBase>
      </Scene>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Control label="lab gap" onPress={() => setGap((value) => (value + 1) % GAPS.length)} />
        <Control label="lab move" onPress={() => setSelected((value) => (value + 1) % 3)} />
        <Control label="lab third" onPress={() => setThird((value) => !value)} />
      </View>
    </View>
  );
}
