// LOCAL MEASUREMENT FIXTURE — never committed.
import { Text, View } from 'react-native';
import { Slot } from 'expo-router';
import { RouterTabs } from '@oxy.so/bloom/tabs/expo-router';

const ITEMS = [
  { value: 'one', label: 'Following', href: '/motion-lab/tabs' },
  { value: 'two', label: 'Explore', href: '/motion-lab/tabs/two' },
];

export default function TabsLab() {
  return (
    <View style={{ flex: 1, paddingTop: 120 }}>
      <Text>Motion lab: tabs</Text>
      <RouterTabs items={ITEMS} variant="underline" />
      <Slot />
    </View>
  );
}
