import NativeDeck from '@/app/(app)/deck';
import WebDeck from '@/app/(app)/deck.web';

let mockAvailable = true;
jest.mock('../useDeckAvailable', () => ({ useDeckAvailable: () => mockAvailable }));
jest.mock('@/lib/navigation/router', () => ({ Redirect: () => null }));

it('keeps native Deck deep links on the ordinary home screen', () => {
  mockAvailable = true;
  expect(NativeDeck().props.href).toBe('/');
});
it('lets the desktop web shell render the Deck panels', () => {
  mockAvailable = true;
  expect(WebDeck()).toBeNull();
});
it('redirects compact web Deck links to the ordinary home screen', () => {
  mockAvailable = false;
  expect(WebDeck()?.props.href).toBe('/');
});
