import {
  checkoutSections,
  emptyCheckoutDraft,
  nextCheckoutStep,
  type CheckoutRequest,
} from '../checkoutFlow';
const request: CheckoutRequest = {
  merchant: 'Merchant',
  currency: 'USD',
  dueTodayMinorUnits: 599,
  items: [],
  requiresShipping: false,
  paymentMethods: ['card'],
};
it('subscriptions require contact and a supported payment method, never shipping', () => {
  const draft = emptyCheckoutDraft();
  expect(checkoutSections(request)).toEqual(['contact', 'payment']);
  expect(nextCheckoutStep(request, draft)).toBe('contact');
  draft.email = 'test@example.test';
  expect(nextCheckoutStep(request, draft)).toBe('payment');
  draft.card = { id: 'demo', brand: 'Visa', last4: '4242', saveForLater: false };
  expect(nextCheckoutStep(request, draft)).toBe('review');
  expect(nextCheckoutStep({ ...request, paymentMethods: ['faircoin'] }, draft)).toBe('payment');
});
it('physical checkout conditionally requires address and delivery before a method', () => {
  const physical = { ...request, requiresShipping: true };
  const draft = { ...emptyCheckoutDraft(), email: 'test@example.test' };
  expect(checkoutSections(physical)).toEqual(['contact', 'shipping', 'delivery', 'payment']);
  expect(nextCheckoutStep(physical, draft)).toBe('shipping');
  draft.shipping = {
    name: 'Demo',
    address: '1 Sample Street',
    city: 'Sample',
    postalCode: '00000',
    country: 'Sample',
  };
  expect(nextCheckoutStep(physical, draft)).toBe('delivery');
  draft.delivery = 'standard';
  expect(nextCheckoutStep(physical, draft)).toBe('payment');
});
