import { useMentionSettings,type MentionSettingsActions } from '@/context/MentionSettingsContext';
import TestRenderer,{ act } from 'react-test-renderer';
import { MentionSettingsProvider,SETTINGS_PAGE_IDS,settingsPageFromRoute } from '../MentionSettingsProvider';
import { createSettingsRoute } from '../SettingsRoute';

let mockModal: Record<string, any>;
const mockOpen = jest.fn(() => ({ page: mockModal.page, initialView: mockModal.initialView }));
const mockClose = jest.fn();
const mockControl = { open: mockOpen, close: mockClose };
const mockRouter = { navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('@oxy.so/bloom/dialog', () => ({ useDialogControl: () => mockControl }));
jest.mock('@oxy.so/bloom/settings-modal', () => ({ SettingsModal: (props: Record<string, any>) => { mockModal = props; return null; } }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string } | string) => typeof options === 'string' ? options : options?.defaultValue ?? key }) }));
let actions: MentionSettingsActions;
function Probe() { actions = useMentionSettings(); return null; }
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { jest.clearAllMocks(); mockRouter.canGoBack.mockReturnValue(true); });
afterEach(() => { act(() => renderer?.unmount()); });

it('opens after selected page and compact initial view commit, including reopening', () => {
  act(() => { renderer = TestRenderer.create(<MentionSettingsProvider><Probe /></MentionSettingsProvider>); });
  act(() => actions.open());
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'account', initialView: 'navigation' });
  act(() => actions.open('appearance'));
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'appearance', initialView: 'page' });
  act(() => actions.close());
  act(() => mockModal.onClose());
  act(() => actions.open('language'));
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'language', initialView: 'page' });
});

it('keeps subpages in one modal and waits for dismissal before SDK actions', () => {
  act(() => { renderer = TestRenderer.create(<MentionSettingsProvider><Probe /></MentionSettingsProvider>); });
  act(() => actions.navigate('/settings/privacy/blocked'));
  expect(mockModal.page).toBe('privacy/blocked');
  expect(mockRouter.navigate).not.toHaveBeenCalled();
  const openSdk = jest.fn();
  act(() => actions.afterClose(openSdk));
  expect(mockClose).toHaveBeenCalled();
  expect(openSdk).not.toHaveBeenCalled();
  act(() => mockModal.onClose());
  expect(openSdk).toHaveBeenCalledTimes(1);
  act(() => mockModal.onClose());
  expect(openSdk).toHaveBeenCalledTimes(1);
});

it('bridges old deep links without leaving a settings screen in the stack', () => {
  const Route = createSettingsRoute('notifications/subscriptions');
  act(() => { renderer = TestRenderer.create(<MentionSettingsProvider><Route /></MentionSettingsProvider>); });
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'notifications/subscriptions', initialView: 'page' });
});

it('retains every settings address and rejects unrelated routes', () => {
  expect(SETTINGS_PAGE_IDS).toHaveLength(25);
  for (const page of SETTINGS_PAGE_IDS) expect(settingsPageFromRoute(page === 'account' ? '/settings' : `/settings/${page}`)).toBe(page);
  expect(settingsPageFromRoute('/transparency')).toBeNull();
});
