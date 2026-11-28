import { act, create } from 'react-test-renderer';
import AuthScreen from '@/app/(auth)/index';

const mockSignIn = jest.fn(() => Promise.resolve());
const mockOpenAccountDialog = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ signIn: mockSignIn }),
  useOxy: () => ({ openAccountDialog: mockOpenAccountDialog }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/assets/logo', () => ({ LogoIcon: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { primary: 'blue' } }) }));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress }: { children: string; onPress: () => void }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable testID={children} onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    );
  },
}));

it('offers a new reader account creation and a returning one sign-in', () => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<AuthScreen />);
  });
  const press = (id: string) =>
    act(() => {
      tree.root.findAll((node) => node.props.testID === id)[0].props.onPress();
    });

  press('auth.signIn.createAccount');
  expect(mockOpenAccountDialog).toHaveBeenCalledWith('signup');
  expect(mockSignIn).not.toHaveBeenCalled();

  press('auth.signIn.withOxy');
  expect(mockSignIn).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
