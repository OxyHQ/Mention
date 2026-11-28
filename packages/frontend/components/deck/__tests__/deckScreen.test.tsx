// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import TestRenderer, { act } from 'react-test-renderer';
import NativeDeck from '@/app/(app)/deck';
import WebDeck from '@/app/(app)/deck.web';
import { useDeckSettings } from '../deckSettings';
import { Redirect } from '@/lib/navigation/router';

let mockAvailable = true;
jest.mock('../useDeckAvailable', () => ({ useDeckAvailable: () => mockAvailable }));
jest.mock('@/lib/navigation/router', () => ({ Redirect: () => null }));

beforeEach(() => {
  mockAvailable = true;
  useDeckSettings.setState({ records: {}, layoutModes: {} });
  useDeckSettings.getState().activate('anonymous');
  useDeckSettings.getState().setDeckEnabled(false);
});

function renderWeb() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WebDeck />);
  });
  const destinations = tree.root.findAllByType(Redirect).map((node) => node.props.href);
  act(() => tree.unmount());
  return destinations;
}

it('keeps native Deck deep links on the ordinary home screen', () => {
  expect(NativeDeck().props.href).toBe('/');
});
it('opens the default Deck around the ordinary home route on a cold link', () => {
  expect(renderWeb()).toEqual(['/']);
  expect(useDeckSettings.getState().deckEnabled).toBe(true);
});
it('lets the desktop shell restore a customized Deck', () => {
  useDeckSettings.getState().updatePanel('deck-0', { source: 'saved' });
  expect(renderWeb()).toEqual(['/']);
  expect(useDeckSettings.getState().deckEnabled).toBe(true);
  expect(useDeckSettings.getState().panels['deck-0'].source).toBe('saved');
});
it('redirects compact web links without activating Deck', () => {
  mockAvailable = false;
  expect(renderWeb()).toEqual(['/']);
  expect(useDeckSettings.getState().deckEnabled).toBe(false);
});
