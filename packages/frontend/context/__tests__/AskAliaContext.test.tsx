import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { AskAliaProvider, useAskAlia } from '@/context/AskAliaContext';

const mockSheet = jest.fn((_props: Record<string, unknown>) => null);
// The provider loads the sheet with `lazy(() => import(...))`, which jest cannot run without
// VM modules; the loader is not what is under test, so `lazy` hands back the sheet directly.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  lazy: () => (props: Record<string, unknown>) => mockSheet(props),
}));

let mockAuth = { canUsePrivateApi: true, signIn: jest.fn(() => Promise.resolve()) };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('expo-router', () => ({ usePathname: () => '/@ada' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { path?: string }) =>
      options?.path ? `${key} ${options.path}` : key,
  }),
}));

function Opener({ onReady }: { onReady: (ask: ReturnType<typeof useAskAlia>) => void }) {
  onReady(useAskAlia());
  return null;
}

async function mount() {
  let ask: ReturnType<typeof useAskAlia> | undefined;
  await act(async () => {
    TestRenderer.create(
      <AskAliaProvider>
        <Opener onReady={(value) => (ask = value)} />
      </AskAliaProvider>,
    );
  });
  if (!ask) throw new Error('the provider did not render');
  return ask;
}

beforeEach(() => {
  mockSheet.mockClear();
  mockAuth = { canUsePrivateApi: true, signIn: jest.fn(() => Promise.resolve()) };
});

describe('AskAliaProvider', () => {
  it('mounts no sheet until the first press', async () => {
    await mount();
    expect(mockSheet).not.toHaveBeenCalled();
  });

  it('presents the sheet with no message for a plain press', async () => {
    const ask = await mount();
    await act(async () => ask.open());
    const props = mockSheet.mock.calls.at(-1)?.[0];
    expect(props?.askId).toBe(1);
    expect(props?.prompt).toBeUndefined();
  });

  it('hands a request’s prompt to the sheet and its context to Alia', async () => {
    const ask = await mount();
    await act(async () => ask.open({ prompt: 'Tell me about @ada', context: 'Profile of Ada.' }));
    const props = mockSheet.mock.calls.at(-1)?.[0];
    expect(props?.prompt).toBe('Tell me about @ada');
    expect(String(props?.clientContext)).toContain('Profile of Ada.');
    expect(String(props?.clientContext)).toContain('/@ada');
  });

  it('presents again on every press, and drops the previous request’s prompt', async () => {
    const ask = await mount();
    await act(async () => ask.open({ prompt: 'first' }));
    await act(async () => ask.open());
    const props = mockSheet.mock.calls.at(-1)?.[0];
    expect(props?.askId).toBe(2);
    expect(props?.prompt).toBeUndefined();
  });

  it('signs in instead of mounting the sheet when there is no session', async () => {
    mockAuth = { canUsePrivateApi: false, signIn: jest.fn(() => Promise.resolve()) };
    const ask = await mount();
    await act(async () => ask.open({ prompt: 'x' }));
    expect(mockAuth.signIn).toHaveBeenCalledTimes(1);
    expect(mockSheet).not.toHaveBeenCalled();
  });
});
