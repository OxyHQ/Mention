import TestRenderer, { act } from 'react-test-renderer';

import { ProfileFields } from '../ProfileFields';

/**
 * A federated profile's metadata table renders each row as a Bloom item: the
 * name, the server's plain-text value re-linked, and a verified badge only on a
 * row whose link the origin verified.
 */

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/icons/RiCheckboxCircleLine', () => ({ RiCheckboxCircleLine: () => null }));
jest.mock('@oxy.so/bloom/badge', () => ({ Badge: () => null }));
jest.mock('@oxy.so/bloom/item', () => ({ Item: () => null }));
jest.mock('@/components/common/LinkifiedText', () => ({ LinkifiedText: () => null }));

const { Item } = jest.requireMock<typeof import('@oxy.so/bloom/item')>('@oxy.so/bloom/item');

function render(fields: Parameters<typeof ProfileFields>[0]['fields']) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<ProfileFields fields={fields} />);
  });
  return tree as TestRenderer.ReactTestRenderer;
}

it('renders one item per field, with a verified badge only where verified', () => {
  const tree = render([
    { name: 'Site', value: 'https://someone.example/', verifiedAt: '2026-01-02T00:00:00.000Z' },
    { name: 'Pronouns', value: 'they/them' },
  ]);
  const items = tree.root.findAllByType(Item);
  expect(items.map((item) => item.props.title)).toEqual(['Site', 'Pronouns']);
  expect(items[0].props.subtitle.props.text).toBe('https://someone.example/');
  expect(items[0].props.trailing.props.content).toBe('profile.fields.verified');
  expect(items[1].props.trailing).toBeUndefined();
});

it('renders nothing without fields', () => {
  expect(render(undefined).toJSON()).toBeNull();
});
