import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { toElement } from '@oxy.so/bloom-language';
import PostCommunityRow from '../PostCommunityRow.bloom';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/**
 * The row says where a federated post was written — "in !technology@lemmy.world"
 * — and opens that community's profile without opening the post underneath it.
 */

jest.mock('react-i18next', () => {
  const en: { post: Record<string, string> } = require('@/locales/en.json');
  return {
    useTranslation: () => ({
      t: (key: string, values: Record<string, string>) =>
        (en.post[key.replace(/^post\./, '')] ?? key).replace(
          /\{\{(\w+)\}\}/g,
          (_: string, name: string) => values[name],
        ),
    }),
  };
});

const mockLinkProps = jest.fn();
jest.mock('@/lib/navigation/router', () => ({
  Link: (props: { children: React.ReactNode }) => {
    mockLinkProps(props);
    return props.children;
  },
}));

function text(node: TestRenderer.ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? [])
    .map((child) => text(child as TestRenderer.ReactTestInstance))
    .join('');
}

it('names the community and links to its profile, without opening the post', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    // Under Bloom's theme, as the app draws it: the row's language text paints from it.
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {toElement(
          PostCommunityRow({
            handle: 'technology@lemmy.world',
            href: '/@technology@lemmy.world',
            iconColor: '#888',
          }),
        )}
      </BloomThemeProvider>,
    );
  });

  expect(text(renderer.root)).toBe('in !technology@lemmy.world');
  const link = mockLinkProps.mock.calls[0][0] as {
    href: string;
    onPress: (event: { stopPropagation: () => void }) => void;
  };
  expect(link.href).toBe('/@technology@lemmy.world');
  const stopPropagation = jest.fn();
  link.onPress({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalled();
});
