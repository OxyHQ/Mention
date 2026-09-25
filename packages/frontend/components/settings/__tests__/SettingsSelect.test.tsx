import { StyleSheet } from 'react-native';
import TestRenderer,{ act } from 'react-test-renderer';
import { SettingsSelect } from '../SettingsSelect';

let mockTrigger: Record<string, unknown>;
jest.mock('@oxy.so/bloom/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => children,
  SelectTrigger: (props: Record<string, unknown>) => { mockTrigger = props; return null; },
  SelectContent: () => null,
  SelectIcon: () => null,
  SelectItem: () => null,
  SelectItemIndicator: () => null,
  SelectItemText: () => null,
  SelectValue: () => null,
}));

/**
 * A trigger with a pinned height clips its value on Android: `h-8` left 15.5dp
 * for a 20dp line (#1126). The value's own line must set the height.
 */
it('sizes the trigger by its padding, never a fixed height', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<SettingsSelect label="Mode" value="a" onChange={() => {}} items={[{ value: 'a', label: 'A' }]} />); });
  expect(String(mockTrigger.className ?? '')).not.toMatch(/(^|\s)(h|min-h|max-h)-/);
  const field = StyleSheet.flatten(mockTrigger.fieldStyle as object) as Record<string, unknown>;
  expect(field.height).toBeUndefined();
  expect(field.paddingTop).toBeGreaterThan(0);
  act(() => renderer.unmount());
});
