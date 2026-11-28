import { act, create } from 'react-test-renderer';
import { PostSearchFilterChips } from '@/components/search/PostSearchFilterChips';
import { NO_POST_SEARCH_FILTERS } from '@/utils/postSearchFilters';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/chip', () => ({
  ChipRow: ({ children }: { children: React.ReactNode }) => children,
  Chip: ({
    children,
    selected,
    onPress,
  }: {
    children: string;
    selected: boolean;
    onPress: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable testID={children} accessibilityState={{ selected }} onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    );
  },
}));

it('toggles one filter and leaves the others as they are', () => {
  const onChange = jest.fn();
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <PostSearchFilterChips
        filters={{ ...NO_POST_SEARCH_FILTERS, media: true }}
        onChange={onChange}
      />,
    );
  });
  const press = (id: string) =>
    act(() => {
      tree.root.findAll((node) => node.props.testID === id)[0].props.onPress();
    });

  press('search.filters.popular');
  expect(onChange).toHaveBeenLastCalledWith({ media: true, pastWeek: false, popular: true });
  press('search.filters.media');
  expect(onChange).toHaveBeenLastCalledWith({ media: false, pastWeek: false, popular: false });
  act(() => tree.unmount());
});
