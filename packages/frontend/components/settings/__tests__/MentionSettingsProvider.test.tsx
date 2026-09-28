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
jest.mock('../settingsPages', () => ({ useMentionSettingsPages: () => ({ pages: {}, groups: [] }) }));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
// Jest cannot run `import()`, so the provider's lazy dialog renders the real
// module synchronously; the provider still decides WHEN it mounts.
jest.mock('react', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    ...R,
    lazy: () => (props: object) =>
      R.createElement(jest.requireActual('../MentionSettingsModal').default, props),
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string } | string) => typeof options === 'string' ? options : options?.defaultValue ?? key }) }));
let actions: MentionSettingsActions;
function Probe() { actions = useMentionSettings(); return null; }
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { jest.clearAllMocks(); mockRouter.canGoBack.mockReturnValue(true); });
afterEach(() => { act(() => renderer?.unmount()); });

it('opens after selected page and compact initial view commit, including reopening', async () => {
  act(() => { renderer = TestRenderer.create(<MentionSettingsProvider><Probe /></MentionSettingsProvider>); });
  await act(async () => actions.open());
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'account', initialView: 'navigation' });
  act(() => actions.open('appearance'));
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'appearance', initialView: 'page' });
  act(() => actions.close());
  act(() => mockModal.onClose());
  act(() => actions.open('language'));
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'language', initialView: 'page' });
});

it('keeps subpages in one modal and waits for dismissal before SDK actions', async () => {
  act(() => { renderer = TestRenderer.create(<MentionSettingsProvider><Probe /></MentionSettingsProvider>); });
  await act(async () => actions.navigate('/settings/privacy/blocked'));
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

it('bridges old deep links without leaving a settings screen in the stack', async () => {
  const Route = createSettingsRoute('notifications/subscriptions');
  await act(async () => { renderer = TestRenderer.create(<MentionSettingsProvider><Route /></MentionSettingsProvider>); });
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(mockOpen.mock.results.at(-1)?.value).toEqual({ page: 'notifications/subscriptions', initialView: 'page' });
});

it('keeps the dialog and its pages out of the tree until the first open request', async () => {
  mockModal = undefined as unknown as Record<string, any>;
  await act(async () => { renderer = TestRenderer.create(<MentionSettingsProvider><Probe /></MentionSettingsProvider>); });
  expect(mockModal).toBeUndefined();
  expect(mockOpen).not.toHaveBeenCalled();
  await act(async () => actions.open('feed'));
  expect(mockModal.page).toBe('feed');
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it('retains every settings address and rejects unrelated routes', () => {
  expect(SETTINGS_PAGE_IDS).toHaveLength(25);
  for (const page of SETTINGS_PAGE_IDS) expect(settingsPageFromRoute(page === 'account' ? '/settings' : `/settings/${page}`)).toBe(page);
  expect(settingsPageFromRoute('/transparency')).toBeNull();
});
