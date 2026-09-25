import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The signed-out gate for create forms and owned directories (#1126, item 8).
 *
 * Three states, and the one that matters most is the middle one: a session the
 * SDK reports as `isAuthenticated` but that cannot make a private call yet must
 * NOT see the form, because submitting it is exactly the silent 401 the issue
 * reproduced on Live Rooms.
 */

type AuthState = {
  isAuthResolved: boolean;
  isPrivateApiPending: boolean;
  canUsePrivateApi: boolean;
  isAuthenticated: boolean;
};

let mockAuth: AuthState;

jest.mock('@oxy.so/services/ui/client', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    OxyAuthPrompt: ({ label }: { label: string }) => <MockText testID="auth-prompt">{label}</MockText>,
    useAuth: () => mockAuth,
  };
});
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));

import { SignInRequired } from '../SignInRequired';

function render(): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <SignInRequired label="Sign in to create a list">
        <Text testID="form">form</Text>
      </SignInRequired>,
    );
  });
  return tree;
}

/** Host nodes only — a composite and the host it renders share the testID. */
const hosts = (tree: TestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
const has = (tree: TestRenderer.ReactTestRenderer, testID: string) => hosts(tree, testID).length > 0;

describe('SignInRequired', () => {
  it('holds a spinner while the session is still resolving', () => {
    mockAuth = { isAuthResolved: false, isPrivateApiPending: false, canUsePrivateApi: false, isAuthenticated: false };
    const tree = render();
    expect(has(tree, 'sign-in-required-pending')).toBe(true);
    expect(has(tree, 'auth-prompt')).toBe(false);
    expect(has(tree, 'form')).toBe(false);
  });

  it('holds the spinner while the private API is pending, even when authenticated', () => {
    mockAuth = { isAuthResolved: true, isPrivateApiPending: true, canUsePrivateApi: false, isAuthenticated: true };
    const tree = render();
    expect(has(tree, 'sign-in-required-pending')).toBe(true);
    expect(has(tree, 'form')).toBe(false);
  });

  it('prompts a signed-out reader to sign in instead of showing the form', () => {
    mockAuth = { isAuthResolved: true, isPrivateApiPending: false, canUsePrivateApi: false, isAuthenticated: false };
    const tree = render();
    const prompt = hosts(tree, 'auth-prompt');
    expect(prompt).toHaveLength(1);
    expect(prompt[0].props.children).toBe('Sign in to create a list');
    expect(has(tree, 'form')).toBe(false);
  });

  it('gates on canUsePrivateApi, not isAuthenticated', () => {
    mockAuth = { isAuthResolved: true, isPrivateApiPending: false, canUsePrivateApi: false, isAuthenticated: true };
    const tree = render();
    expect(has(tree, 'auth-prompt')).toBe(true);
    expect(has(tree, 'form')).toBe(false);
  });

  it('renders the form for a reader who can use the private API', () => {
    mockAuth = { isAuthResolved: true, isPrivateApiPending: false, canUsePrivateApi: true, isAuthenticated: true };
    const tree = render();
    expect(has(tree, 'form')).toBe(true);
    expect(has(tree, 'auth-prompt')).toBe(false);
  });
});
