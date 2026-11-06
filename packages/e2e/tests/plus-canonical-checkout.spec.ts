import { test, expect } from '../fixtures';
import { APP_ORIGIN } from '../environment';
import { installDraftFixture, DRAFT_VIEWER_ID } from '../draftFixture';
const SESSION_ID = 'cs_0123456789abcdef01234567';
const session = {
  id: SESSION_ID,
  object: 'checkout_session',
  livemode: false,
  mode: 'subscription',
  status: 'open',
  payment_status: 'unpaid',
  ui_mode: 'embedded',
  locale: null,
  submit_type: 'auto',
  currency: 'USD',
  rail: 'card',
  network: null,
  line_items: [
    {
      id: 'li_fixture',
      object: 'item',
      description: 'Mention Plus',
      price: null,
      product: null,
      images: [],
      quantity: 1,
      adjustable_quantity: { enabled: false },
      currency: 'USD',
      unit_amount: '599',
      amount_subtotal: '599',
      amount_discount: '0',
      amount_tax: '0',
      amount_total: '599',
    },
  ],
  amount_subtotal: '599',
  amount_total: '599',
  total_details: { amount_discount: '0', amount_tax: '0', amount_shipping: '0' },
  discount: null,
  allow_promotion_codes: false,
  automatic_tax: { enabled: true, status: 'requires_location_inputs' },
  customer_details: {
    email: null,
    name: null,
    phone: null,
    address: {
      country: 'US',
      state: null,
      postal_code: '19802',
      line1: null,
      line2: null,
      city: null,
    },
    tax_ids: [],
  },
  customer_email_locked: false,
  contact_collection: 'merchant_account',
  billing_address_collection: 'auto',
  shipping_address_collection: null,
  shipping_details: null,
  phone_number_collection: { enabled: false },
  tax_id_collection: { enabled: false },
  custom_fields: [],
  consent_collection: null,
  consent: null,
  terms_of_service_url: null,
  payment_intent: null,
  setup_intent: null,
  success_url: null,
  cancel_url: null,
  confirmation_message: null,
  merchant: { name: 'Mention', avatar_url: null, logo_url: null, description: null },
  branding: {
    icon_url: null,
    logo_url: null,
    primary_color: '#1f6feb',
    accent_color: '#0b1f33',
    font: 'system',
    border_style: 'rounded',
  },
  publishable_key: 'pk_test_synthetic_not_a_real_key',
  payment_method_types: ['card', 'faircoin'],
  faircoin: { available: false, unavailable_reason: 'faircoin_wallet_missing' },
  expires_at: 2000000000,
};

for (const width of [1440, 390]) {
  test(`Plus opens canonical review and methods at ${width}px`, async ({
    page,
    context,
    candidate,
  }) => {
    expect(candidate.servedPaths).toBeDefined();
    await page.setViewportSize({ width, height: 900 });
    await installDraftFixture(context, { seedDrafts: false });
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    let starts = 0;
    let confirms = 0;
    await context.route('**/billing/product-plans/mention', (route) =>
      route.fulfill({
        headers,
        json: {
          schemaVersion: 1,
          productId: 'mention',
          purchase: 'available',
          plans: [
            {
              productId: 'mention',
              offerId: 'mention_plus_monthly',
              offerVersion: 1,
              displayName: 'Mention Plus',
              price: {
                currency: 'USD',
                amountMinorUnits: 599,
                interval: 'month',
                trial: 'none',
                taxTreatment: 'inclusive',
                merchantTotal: 'final',
              },
            },
          ],
        },
      }),
    );
    await context.route('**/v1/products/mention/access/*', (route) =>
      route.fulfill({
        headers,
        json: {
          schemaVersion: 1,
          subjectAccountId: DRAFT_VIEWER_ID,
          productId: 'mention',
          evaluatedAt: new Date().toISOString(),
          capabilities: [],
          quotas: [],
          conflicts: [],
        },
      }),
    );
    await context.route('**/billing/checkout/product-plan', (route) => {
      starts++;
      return route.fulfill({
        headers,
        json: {
          state: 'pending',
          intentId: 'fixture_plus',
          checkoutUrl: `https://checkout.peable.to/c/${SESSION_ID}#cs=${SESSION_ID}_secret_0123456789abcdef`,
        },
      });
    });
    await context.route('**/v1/checkout_sessions/**', (route) => {
      if (route.request().method() !== 'GET') {
        confirms++;
        return route.abort();
      }
      return route.fulfill({ headers, json: session });
    });
    await page.goto('/plus');
    await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Mention Plus', { exact: true })).toBeVisible();
    await expect(sheet.getByText('$5.99', { exact: true }).first()).toBeVisible();
    expect(starts).toBe(0);
    await sheet.evaluate((element) => element.setAttribute('data-preparation-probe', 'same-sheet'));
    await expect(sheet.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
    const continueButton = sheet.getByRole('button', { name: 'Continue', exact: true });
    await expect(continueButton).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        sheet.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight),
      )
      .toBe(true);
    await sheet.evaluate(async (element) => {
      let previous = '';
      let stable = 0;
      while (stable < 4) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const rect = element.getBoundingClientRect();
        const next = [rect.x, rect.y, rect.width, rect.height]
          .map((value) => value.toFixed(1))
          .join(',');
        stable = next === previous ? stable + 1 : 0;
        previous = next;
      }
    });
    await expect(continueButton).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `/tmp/mention-canonical-review-${width}.png` });
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => starts).toBe(1);

    await expect(sheet.getByText('FairCoin', { exact: true }).first()).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: 'Add another card', exact: true }).first(),
    ).toBeVisible();
    expect(confirms).toBe(0);
    await expect(sheet).toHaveAttribute('data-preparation-probe', 'same-sheet');
    await expect(sheet.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `/tmp/mention-canonical-${width}.png` });
    await sheet.getByRole('button', { name: 'Add another card', exact: true }).click();
    const region = sheet.getByRole('textbox', {
      name: 'State / province code (2 letters)',
      exact: true,
    });
    await expect(region).toBeVisible();
    const billingContinue = sheet.getByRole('button', { name: 'Continue', exact: true });
    await expect(billingContinue).toBeDisabled();
    await region.fill('ZZ');
    await expect(billingContinue).toBeDisabled();
    await region.fill('de');
    await expect(region).toHaveValue('DE');
    await expect(billingContinue).toBeEnabled();
    expect(confirms).toBe(0);
    expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught'))).toEqual([]);
  });
}
