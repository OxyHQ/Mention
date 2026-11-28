import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RestrictedPostNotice } from '@/components/Post/RestrictedPostNotice';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/admonition', () => ({
  Admonition: ({ children }: { children: string }) => {
    const { Text } = require('react-native');
    return <Text>{children}</Text>;
  },
}));

const render = (status: string | undefined) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<RestrictedPostNotice status={status} />);
  });
  return tree;
};

it('tells the reader of a restricted post that it was restricted', () => {
  expect(JSON.stringify(render('restricted').toJSON())).toContain('post.restrictedNotice');
});

it.each(['published', 'draft', 'scheduled', undefined])('says nothing for %s', (status) => {
  expect(render(status).toJSON()).toBeNull();
});
