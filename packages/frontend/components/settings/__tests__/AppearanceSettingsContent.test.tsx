import type { SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AppearanceSettingsContent from '../pages/appearance';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

const mockSave = jest.fn();
const mockChangeMode = jest.fn();
const mockToast = jest.fn();
let mockSections: SettingsPageSection[];
/** What Bloom's select was last handed, so a test can work it as a person does. */
let mockSelectProps: { onChange: (value: string) => void } | undefined;
jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) =>
    selector({ mySettings: { appearance: {} }, updateMySettings: mockSave }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAccountThemeControls: () => ({
    source: 'app',
    changeThemeSource: jest.fn(),
    changeThemeMode: mockChangeMode,
  }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useBloomTheme: () => ({ mode: 'system' }),
}));
jest.mock('@oxy.so/bloom/settings-modal', () => ({
  SettingsGeneralPage: ({ sections }: { sections: SettingsPageSection[] }) => {
    mockSections = sections;
    return null;
  },
  // The language draws its SettingsSelect from here; it records what it is handed.
  SettingsSelect: (props: { onChange: (value: string) => void }) => {
    mockSelectProps = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/switch', () => ({ Switch: () => null }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: (...args: unknown[]) => mockToast(...args) },
}));
jest.mock('@oxy.so/bloom/settings-modal/select', () => ({ SettingsSelect: () => null }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string }) =>
      typeof options === 'string' ? options : (options?.defaultValue ?? key),
  }),
}));
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
});
/**
 * The props Bloom's select receives for a row's control. A row's control is a
 * language element, so it is drawn to reach them.
 */
/** Read through a function: TypeScript cannot see the mock assign it while the control draws. */
const drawnSelect = () => mockSelectProps;
function control(section: string, row: string) {
  const element = mockSections
    .find((item) => item.key === section)
    ?.rows.find((item) => item.key === row)?.control as React.ReactElement | undefined;
  if (!element) throw new Error(`no control for ${section}/${row}`);
  mockSelectProps = undefined;
  let drawn!: TestRenderer.ReactTestRenderer;
  act(() => {
    drawn = TestRenderer.create(<BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>);
  });
  act(() => drawn.unmount());
  const select = drawnSelect();
  if (!select) throw new Error(`${section}/${row} drew no select`);
  return select;
}
it.each([null, new Error('Save unavailable')])(
  'reports a failed preference save and clears pending state (%s)',
  async (result) => {
    if (result instanceof Error) mockSave.mockRejectedValue(result);
    else mockSave.mockResolvedValue(result);
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider fonts={false}>
          <AppearanceSettingsContent />
        </BloomThemeProvider>,
      );
    });
    const select = control('reading', 'length');
    await act(async () => select.onChange('more'));
    expect(mockSave).toHaveBeenCalledWith({
      appearance: { postTextExpand: 'more', postReadMoreAction: 'openPost', collapseLongBio: true },
    });
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockSections.find((item) => item.key === 'reading')!.action).toBeUndefined();
  },
);
it('handles rejected theme persistence without an unhandled promise or permanent spinner', async () => {
  mockChangeMode.mockRejectedValue(new Error('Theme unavailable'));
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        <AppearanceSettingsContent />
      </BloomThemeProvider>,
    );
  });
  const select = control('theme', 'mode');
  await act(async () => select.onChange('dark'));
  expect(mockToast).toHaveBeenCalledWith('Theme unavailable');
  expect(mockSections.find((item) => item.key === 'reading')!.action).toBeUndefined();
});
