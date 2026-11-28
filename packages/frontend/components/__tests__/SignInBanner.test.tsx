import TestRenderer, { act } from 'react-test-renderer';
import { SignInBanner } from '../SignInBanner';

const mockCreateAccount = jest.fn();
const mockSignInAccount = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/page-header', () => ({ EdgeScrim: 'EdgeScrim' }));
jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => '#fff' }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { text: '#111', textSecondary: '#666', background: '#fff' } }),
}));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@/components/auth/useAccountEntry', () => ({
  useAccountEntry: () => ({
    createAccount: mockCreateAccount,
    signInAccount: mockSignInAccount,
  }),
}));

beforeEach(() => {
  mockCreateAccount.mockClear();
  mockSignInAccount.mockClear();
});

it('puts create account ahead of sign in on the bottom banner', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SignInBanner />);
  });
  expect(tree.root.findByProps({ testID: 'sign-in-banner' })).toBeTruthy();
  const buttons = tree.root.findAllByType('Button' as never);
  expect(buttons.map((button) => button.props.children)).toEqual([
    'auth.banner.createAccount',
    'auth.banner.signIn',
  ]);
  expect(buttons[0]?.props.testID).toBe('sign-in-banner-create-account');
  act(() => buttons[0]?.props.onPress());
  expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  act(() => buttons[1]?.props.onPress());
  expect(mockSignInAccount).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(tree.toJSON())).toContain('auth.banner.title');
});
