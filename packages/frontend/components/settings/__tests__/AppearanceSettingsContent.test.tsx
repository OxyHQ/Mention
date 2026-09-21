import type { SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import React from 'react';
import TestRenderer,{ act } from 'react-test-renderer';
import AppearanceSettingsContent from '../pages/appearance';

const mockSave = jest.fn();
const mockChangeMode = jest.fn();
const mockToast = jest.fn();
let mockSections: SettingsPageSection[];
jest.mock('@/stores/appearanceStore', () => ({ useAppearanceStore: (selector: (state: unknown) => unknown) => selector({ mySettings: { appearance: {} }, updateMySettings: mockSave }) }));
jest.mock('@/hooks/useAccountTheme', () => ({ useThemeControls: () => ({ source: 'app', changeThemeSource: jest.fn(), changeThemeMode: mockChangeMode }) }));
jest.mock('@oxy.so/bloom/theme', () => ({ useBloomTheme: () => ({ mode: 'system' }) }));
jest.mock('@oxy.so/bloom/settings-modal', () => ({ SettingsGeneralPage: ({ sections }: { sections: SettingsPageSection[] }) => { mockSections = sections; return null; } }));
jest.mock('@oxy.so/bloom/switch', () => ({ Switch: () => null }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: (...args: unknown[]) => mockToast(...args) } }));
jest.mock('@/components/settings/SettingsSelect', () => ({ SettingsSelect: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: string | { defaultValue?: string }) => typeof options === 'string' ? options : options?.defaultValue ?? key }) }));
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { act(() => renderer?.unmount()); });
function control(section: string, row: string) {
  return (mockSections.find(item => item.key === section)!.rows.find(item => item.key === row)!.control as React.ReactElement<{ onChange: (value: string) => void }>).props;
}
it.each([null, new Error('Save unavailable')])('reports a failed preference save and clears pending state (%s)', async (result) => {
  if (result instanceof Error) mockSave.mockRejectedValue(result); else mockSave.mockResolvedValue(result);
  act(() => { renderer = TestRenderer.create(<AppearanceSettingsContent />); });
  await act(async () => control('reading', 'length').onChange('more'));
  expect(mockSave).toHaveBeenCalledWith({ appearance: { postTextExpand: 'more', postReadMoreAction: 'openPost', collapseLongBio: true } });
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(mockSections.find(item => item.key === 'reading')!.action).toBeUndefined();
});
it('handles rejected theme persistence without an unhandled promise or permanent spinner', async () => {
  mockChangeMode.mockRejectedValue(new Error('Theme unavailable'));
  act(() => { renderer = TestRenderer.create(<AppearanceSettingsContent />); });
  await act(async () => control('theme', 'mode').onChange('dark'));
  expect(mockToast).toHaveBeenCalledWith('Theme unavailable');
  expect(mockSections.find(item => item.key === 'reading')!.action).toBeUndefined();
});
