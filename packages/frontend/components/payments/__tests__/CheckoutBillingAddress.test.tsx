import { billingAddressComplete, emptyBillingAddress } from '../CheckoutBillingAddress';
jest.mock('@oxy.so/bloom/typography', () => ({ Text: () => null }));
jest.mock('@oxy.so/bloom/text-field', () => ({
  TextField: () => null,
  TextFieldInput: () => null,
}));
jest.mock('@oxy.so/bloom/select', () => ({}));
it('never infers billing location from a default or display preference', () => {
  expect(emptyBillingAddress()).toEqual({
    country: '',
    state: '',
    postalCode: '',
    city: '',
    line1: '',
    line2: '',
  });
  expect(billingAddressComplete(emptyBillingAddress())).toBe(false);
});
it('accepts explicit bounded address without imposing a postal code on every country', () => {
  const address = {
    ...emptyBillingAddress(),
    country: 'AE',
    city: 'Dubai',
    line1: 'Example street',
  };
  expect(billingAddressComplete(address)).toBe(true);
  expect(billingAddressComplete({ ...address, country: 'ZZ' })).toBe(false);
  expect(billingAddressComplete({ ...address, line1: '  ' })).toBe(false);
  expect(billingAddressComplete({ ...address, state: 'a'.repeat(101) })).toBe(false);
  expect(billingAddressComplete({ ...address, postalCode: 'a'.repeat(33) })).toBe(false);
  expect(billingAddressComplete({ ...address, city: 'Dubai\nOther' })).toBe(false);
});
