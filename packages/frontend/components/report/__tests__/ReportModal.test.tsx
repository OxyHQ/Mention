import TestRenderer, { act } from 'react-test-renderer';
import { TouchableOpacity } from 'react-native';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import ReportModal from '../ReportModal';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import type React from 'react';

/** Under Bloom's theme provider: the language paints its text and glyphs from the theme, as the app's provider supplies it. */
function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useTheme: () => ({ colors: {} }),
}));
jest.mock('@oxy.so/bloom/divider', () => ({
  ...jest.requireActual('@oxy.so/bloom/divider'),
  Divider: () => null,
}));
jest.mock('@oxy.so/bloom/textarea', () => ({
  ...jest.requireActual('@oxy.so/bloom/textarea'),
  Textarea: () => null,
}));
jest.mock('@oxy.so/bloom/checkbox', () => ({
  ...jest.requireActual('@oxy.so/bloom/checkbox'),
  Checkbox: () => null,
}));
jest.mock('@oxy.so/bloom/field', () => ({
  ...jest.requireActual('@oxy.so/bloom/field'),
  Field: () => null,
}));
jest.mock('@/services/reportService', () => ({
  REPORT_CATEGORIES: [{ id: 'spam', label: 'Spam' }],
}));
it('exposes named buttons and the submit disabled state until a reason is chosen', () => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  const onSubmit = jest.fn();
  act(() => {
    tree = TestRenderer.create(
      themed(<ReportModal visible onClose={() => {}} onSubmit={onSubmit} />),
    );
  });
  if (!tree) throw new Error('Report did not render');
  const buttons = tree.root.findAllByType(TouchableOpacity);
  expect(buttons).toHaveLength(3);
  expect(buttons.every((button) => button.props.accessibilityRole === 'button')).toBe(true);
  expect(buttons[0].props.accessibilityLabel).toBe('Close');
  expect(buttons[2].props.accessibilityState).toEqual({ disabled: true });
  act(() => tree?.root.findByType(Checkbox).props.onCheckedChange());
  expect(buttons[2].props.accessibilityState).toEqual({ disabled: false });
  act(() => buttons[2].props.onPress());
  expect(onSubmit).toHaveBeenCalledWith(['spam'], undefined);
  act(() => tree?.unmount());
});
