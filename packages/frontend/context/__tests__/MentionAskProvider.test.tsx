import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { MentionAskProvider, useMentionAskBridge } from '@/context/MentionAskProvider';

const mockProvider = jest.fn((props: { children: React.ReactNode }) => props.children);
const mockAsk = jest.fn();
jest.mock('@alia.onl/sdk/ask', () => {
  const React = require('react');
  return {
    AliaAskProvider: React.forwardRef(
      (props: { children: React.ReactNode }, ref: React.Ref<unknown>) => {
        React.useImperativeHandle(ref, () => ({ ask: mockAsk }));
        return mockProvider(props);
      },
    ),
  };
});
jest.mock('expo-router', () => ({ usePathname: () => '/@ada' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { path?: string }) =>
      options?.path ? `${key} ${options.path}` : key,
  }),
}));

describe('MentionAskProvider', () => {
  it('mounts the SDK’s one sheet, telling Alia the app and the screen the person is on', async () => {
    await act(async () => {
      TestRenderer.create(<MentionAskProvider>{null}</MentionAskProvider>);
    });
    const props = mockProvider.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(props.app).toBe('mention');
    expect(props.clientContext).toBe('alia.clientContext alia.onScreen /@ada');
    expect(props.welcomeSuggestions).toEqual([
      { id: 'news', text: 'alia.suggestion.news' },
      { id: 'write', text: 'alia.suggestion.write' },
      { id: 'discover', text: 'alia.suggestion.discover' },
    ]);
  });
});

it('opens the app’s existing Alia sheet from support, safely before mount and after unmount', () => {
  let bridge!: ReturnType<typeof useMentionAskBridge>;
  function Harness({ ready }: { ready: boolean }) {
    bridge = useMentionAskBridge();
    return ready ? <MentionAskProvider askRef={bridge.askRef}>{null}</MentionAskProvider> : null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Harness ready={false} />);
  });
  const openSupport = bridge.openAlia;
  act(() => {
    openSupport();
  });
  expect(mockAsk).not.toHaveBeenCalled();
  act(() => {
    renderer.update(<Harness ready />);
  });
  expect(bridge.openAlia).toBe(openSupport);
  act(() => {
    openSupport();
  });
  expect(mockAsk).toHaveBeenCalledTimes(1);
  act(() => {
    renderer.update(<Harness ready={false} />);
  });
  act(() => {
    openSupport();
  });
  expect(mockAsk).toHaveBeenCalledTimes(1);
  act(() => {
    renderer.unmount();
  });
});
