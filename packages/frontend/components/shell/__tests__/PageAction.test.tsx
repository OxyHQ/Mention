import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Text, View } from 'react-native';
import { PageAction } from '../PageAction';

let mockBottomInset = 72;
jest.mock('@oxy.so/bloom/layout', () => ({ useBottomEdgeInset: () => mockBottomInset }));

it('moves the route action with the shell navigation clearance without owning its interaction', () => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <PageAction>
        <Text>Create folder</Text>
      </PageAction>,
    );
  });
  if (!tree) throw new Error('PageAction did not mount');
  const mounted = tree;
  expect(mounted.root.findByType(View).props.style.bottom).toBe(88);
  expect(mounted.root.findByType(Text).props.children).toBe('Create folder');
  mockBottomInset = 0;
  act(() => {
    mounted.update(
      <PageAction>
        <Text>Create folder</Text>
      </PageAction>,
    );
  });
  expect(mounted.root.findByType(View).props.style.bottom).toBe(16);
  if (Platform.OS === 'web')
    expect(mounted.root.findByType(View).props.style.marginBottom).toBe(16);
  act(() => mounted.unmount());
});
