import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { MentionAskProvider } from '@/context/MentionAskProvider';

const mockProvider = jest.fn((props: { children: React.ReactNode }) => props.children);
jest.mock('@alia.onl/sdk/ask', () => ({
  AliaAskProvider: (props: { children: React.ReactNode }) => mockProvider(props),
}));
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
    expect(props.clientContext).toBe('alia.clientContext alia.onScreen /@ada');
    expect(props.welcomeSuggestions).toEqual([
      { id: 'news', text: 'alia.suggestion.news' },
      { id: 'write', text: 'alia.suggestion.write' },
      { id: 'discover', text: 'alia.suggestion.discover' },
    ]);
  });
});
