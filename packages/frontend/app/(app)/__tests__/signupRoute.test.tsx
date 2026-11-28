import TestRenderer, { act } from 'react-test-renderer';

const mockCreateAccount = jest.fn();
const mockSignInAccount = jest.fn();
const mockAuth = { isAuthenticated: false, isAuthResolved: true };
let mockParams: Record<string, string | string[] | undefined> = {};

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenBack: () => jest.fn() }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: 'PageHeader' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
jest.mock('@/components/SEO', () => ({ SEO: 'SEO' }));
jest.mock('@/components/auth/useAccountEntry', () => ({
  useAccountEntry: () => ({
    createAccount: mockCreateAccount,
    signInAccount: mockSignInAccount,
  }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuth,
}));
jest.mock('@/lib/navigation/router', () => ({
  Redirect: 'Redirect',
  useGlobalSearchParams: () => mockParams,
}));

import SignupRoute from '../signup';

function render() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SignupRoute />);
  });
  return tree;
}

beforeEach(() => {
  mockAuth.isAuthenticated = false;
  mockAuth.isAuthResolved = true;
  mockParams = { utm_source: 'ads', utm_medium: 'cpc', ref: 'landing' };
  mockCreateAccount.mockClear();
  mockSignInAccount.mockClear();
});

it('opens the signup dialog and leaves the campaign URL in place', () => {
  const tree = render();
  expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  expect(tree.root.findAllByType('Redirect' as never)).toHaveLength(0);
  const buttons = tree.root.findAllByType('Button' as never);
  expect(buttons.map((button) => button.props.children)).toEqual([
    'auth.banner.createAccount',
    'auth.banner.signIn',
  ]);
  expect(JSON.stringify(tree.toJSON())).toContain('auth.gate.title');
  act(() => buttons[1]?.props.onPress());
  expect(mockSignInAccount).toHaveBeenCalledTimes(1);
});

it('does not open signup again on a later render of the same visit', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SignupRoute />);
  });
  act(() => {
    tree.update(<SignupRoute />);
  });
  expect(mockCreateAccount).toHaveBeenCalledTimes(1);
});

it('sends a signed-in reader home with the entry query still attached', () => {
  mockAuth.isAuthenticated = true;
  const tree = render();
  expect(mockCreateAccount).not.toHaveBeenCalled();
  const redirect = tree.root.findByType('Redirect' as never);
  expect(redirect.props.href).toBe('/?utm_medium=cpc&utm_source=ads');
  expect(redirect.props.href).not.toContain('ref=');
});

it('waits until auth has resolved before opening signup or leaving', () => {
  mockAuth.isAuthResolved = false;
  expect(render().toJSON()).toBeNull();
  expect(mockCreateAccount).not.toHaveBeenCalled();
});
