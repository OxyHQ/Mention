# Mention Plus payment sheet

Mention Plus is purchasable as a standalone product and is also included with Oxy One.
Oxy remains authoritative for both subscription sources; Mention does not create
a second price catalogue or paid-access flag.

Subscribe opens a Bloom detached **Pay with Peable** bottom sheet. The page and sheet both read
the selected monthly or annual standalone offer from Oxy's published product-plan catalogue; they show no
static replacement price when it is unavailable. Continue opens the authoritative
hosted payment URL in a browser popup on web or an in-app browser on native. The
hosted surface depends on the selected provider/rail; the sheet does not embed a
card form or sign a FairCoin payment itself.

## Deployment binding

Set these public build-time values only after the commercial owner has approved
the exact standalone Mention Plus product, capability and offer:

- `EXPO_PUBLIC_MENTION_PLUS_PRODUCT_ID`: the registered Mention Plus product ID.
- `EXPO_PUBLIC_MENTION_PLUS_CAPABILITY_KEY`: the central capability granting Plus.
- `EXPO_PUBLIC_MENTION_PLUS_OFFER_ID`: the published monthly individual offer ID.
- `EXPO_PUBLIC_MENTION_PLUS_OFFER_VERSION`: its exact positive integer version.
- `EXPO_PUBLIC_MENTION_PLUS_ANNUAL_OFFER_ID`: the published annual individual offer ID.
- `EXPO_PUBLIC_MENTION_PLUS_ANNUAL_OFFER_VERSION`: its exact positive integer version.

For the hosted web app, store these six public identities in the repository or
`production` environment GitHub Actions variables. `deploy-frontends.yml` passes
them explicitly to the Expo build; they are not secrets. Changing a value requires
a new verified frontend build/deploy. Setting Worker runtime variables does not
change the already-inlined bundle. Missing values continue to disable purchasing.
Native builds and OTA updates read them from the `production` profile's `env` in
`packages/frontend/eas.json` (`android-release.yml`, `publish-update.yml`); keep it
in step with the repository variables.
The frontend never receives provider credentials or a client-supplied price.

The central catalogue must be configured, allow purchases, and expose exactly one
matching individual product offer for each selected cadence with an approved price. The backend
must also accept that offer under its commercial eligibility rules and have the
Peable payment/tax/provider binding configured. These frontend values identify an
offer; they cannot activate it or bypass those gates. Never infer a binding from a
name, a displayed price or a generic premium flag. Changing benefits/version needs
a reviewed central offer and updated build configuration.

Public pricing loads independently of sign-in. Signed-out users see a sign-in
step; signed-in users without an available offer see the unavailable state.
Subscribe still opens the sheet in either case. No checkout is created. No approved standalone product/offer binding was supplied or enabled during this
change; no production purchase or entitlement activation has been demonstrated.

## Monthly and annual pricing

The Bloom segmented selector defaults to monthly. Annual costs 20% less than twelve
monthly payments, billed as the published annual total. The client verifies that
both reviewed offers have the same product, capability and currency, and that the
annual minor-unit amount equals `round(monthlyMinorUnits * 12 * 80 / 100)`.
Rounding is to the nearest currency minor unit, half up, using integer arithmetic
(`(monthlyMinorUnits * 48 + 2) / 5`, integer division). Display uses the currency's
fraction digits, including zero- and three-decimal currencies.

This calculation validates the catalogue; it never creates a price or overwrites
the backend total. A missing, stale, wrong-cadence, different-currency or mismatched
annual offer is unavailable while a valid monthly offer remains usable. No
commercial amount or currency is configured by this source change.

The selected cadence is locked while the payment sheet is open. Once an operation
starts, its reviewed offer and amount remain frozen through status checks even if
the catalogue refetches. Closing the sheet and switching cadence preserves each
offer's pending operation key; switching back resumes its existing operation.

## Display currency preference

The approved billing price remains USD. The page and payment sheet use Oxy
Services' shared `useDisplayPrice` hook for a secondary estimate in the account's
preferred display currency, following the same preferences authority as other
Oxy applications. The shared hook owns rates, freshness and the approximate or
unavailable message. Mention does not fetch or invent an exchange rate.

A non-USD estimate states that the charge is in USD. If conversion is unavailable,
the actual USD offer remains visible and purchasable. Selecting a display currency
never changes the approved offer, checkout request, payment total or recovery key.

## Payment outcomes and recovery

The operation key is saved before checkout creation, scoped by account, offer and
version. Browser Web Locks serialize the shared storage read/create across tabs;
web hosts without that API fail before checkout instead of risking replacement of
a recovery key. Native calls share an in-process creation promise. Interrupted
responses, duplicate clicks, popup blocking and dismissal retain the key. Check
payment status uses the same operation and never trusts a browser return URL.

Entitlement discovery requires only the product ID and capability key, independently
of standalone-offer availability. An authoritative product-access query recognizes
existing Plus rights from either
an individual purchase or an Oxy One bundle and prevents another purchase. The
capability is checked again immediately before checkout creation. Only an
authoritative `fulfilled` response refreshes account-scoped product-access and
personalization queries. The client never writes a paid entitlement.
Pending payment, closed checkout, unavailable offer, transport failure and a
payment requiring review are separate states. A review-required response offers
no new payment action. Account/session changes close the owned window and discard
old responses. Cleanup dismisses a native browser only while this sheet owns it.

This is Mention's first consumer of the Peable window flow, not a general-purpose
published SDK sheet. Production acceptance still requires the approved binding,
backend deployment, web/native payment tests, and authoritative renewal,
cancellation and entitlement verification. No cryptocurrency sale or purchase
service is introduced.

## Published prices and payment readiness

An exact public catalogue offer may be shown while the catalogue reports
`purchase: unavailable`. The page and sheet display those published terms, but
the sheet does not open a payment window or create a checkout operation until
the catalogue reports `purchase: available`. An existing pending operation can
still be checked. Missing offers never receive a client-supplied price.

The initial inactive Mention catalogue uses product `mention`, capability
`plus`, monthly offer `mention_plus_monthly` version `1`, and annual offer
`mention_plus_annual` version `1`. Configure the six public bindings above to
these identifiers after that catalogue is published. The approved USD totals
are 599 minor units monthly and 5750 annually, inclusive of tax. These display
terms alone do not activate a payment provider or establish tax readiness.

## Local UI preview

`Subscribe` opens the detached Peable sheet before purchase activation so the
plan can be inspected without signing in. Real payment confirmation remains
gated by the public catalogue and authoritative account access.

For local UI work only, start Expo development mode with
`EXPO_PUBLIC_MENTION_PLUS_UI_PREVIEW=true` and open the web app on `localhost`,
`127.0.0.1` or `[::1]`. All three conditions are required: explicit opt-in,
`__DEV__`, and a loopback web host. Development scenario and outcome controls
live on the host page, outside the payment sheet. Choose subscription, physical
order or a generic trial example, then open Subscribe. Physical orders collect
shipping and delivery; subscriptions omit both. The generic trial shows zero
due today and a separate future recurring charge, without advertising a Mention
trial. Subscription prices come from the actual published catalogue; the physical
and trial examples are explicitly labelled local fixtures.

The checkout uses Bloom's grouped sections, fields and buttons inside its
morphing detached bottom dialog. Contact, shipping and card-selection drafts
survive Back navigation. The local Add card view uses Bloom CardForm with controlled
number, expiry, security code and billing fields. These values remain in that
mounted component only and are cleared before completion; Back, close and unmount
discard them. Only brand/last-four metadata leaves the component. It does not
log, store or transmit card input, and does not replace production provider-hosted
collection. Opt-in saved-card metadata stays in memory
only until the sheet closes. The optional host authorization callback models a
future device capability; no biometric implementation is claimed or enabled.

Authorization simulates the selected loading/success/failure outcome. It never
calls checkout, opens a payment window, writes an operation key, refreshes
entitlements or grants access. Production builds and non-loopback hosts cannot
enable this simulation. The merchant-neutral request/step model and controlled
presentation now live in Bloom; Peable branding and copy live in the optional
SDK UI adapter. These local sources have not been published as a payment API.
The authoritative Oxy checkout wrapper remains separate from the local simulator.
The local host keeps success visible for 1.5 seconds, restores the bare logo for
300 ms, then closes once. Dismissal, navigation and unmount cancel completion
timers; failures remain open for retry. This presentation never establishes a
payment outcome or entitlement. Success and failure illustrations reuse Mention’s
existing catalogue stickers through Bloom’s generic illustration slot; the footer
remains the only status glyph. Catalogue entries warm in the shared cache during
review, and unavailable artwork never delays completion.

### Live iteration

Serve the active isolated implementation worktree while refining the UI, so
Metro Fast Refresh shows source edits immediately. Run Expo from
`packages/frontend` with `CI` unset; do not use `CI=true` or `CI=1`, which disables
watching. Keep the agreed local URL stable. A separate preview checkout that
needs repeated cherry-picks is unsuitable for interactive design work.

Local upstream Bloom builds may be consumed in that worktree's isolated
`node_modules` for review, with the original package preserved for restoration.
Do not change production dependency locks or the user's original dirty checkout
for this preview. Keep simulation enabled only through the explicit local
process setting above; local UI iteration does not authorize publication.

The local checkout now spans three owners: Bloom provides the controlled,
merchant-neutral `CheckoutSheet`; `@peable.to/sdk/checkout/ui` supplies Peable
branding and copy as an optional UI entry; Mention supplies the offer binding
and local preview controller. Headless SDK entries do not import the sheet.

For live library iteration, set `OXY_LOCAL_CHECKOUT_SOURCES=1`,
`OXY_LOCAL_CHECKOUT_ORIGIN=http://localhost:8110`, `OXY_LOCAL_BLOOM_SOURCE` to the
active Bloom package directory, and `OXY_LOCAL_PEABLE_SDK_SOURCE` to the active
Peable `packages/sdk` directory. The opt-in Metro resolver watches those source
roots, resolves Bloom's declared source exports and the SDK UI entry directly,
and shares Mention's React/native peers. Changes in all three working trees
then use Fast Refresh; do not replace this with repeated package-copy cycles.
Keep installed dependencies stable while Metro is serving: directory/symlink
replacement invalidates its file map. Verify new declarations with a temporary
TypeScript path configuration or a separate checkout, rather than changing the
serving worktree’s dependency layout.
The resolver refuses production, CI and non-loopback settings and is inactive
without the explicit flag. A published SDK version containing the optional UI
entry is still required before any production consumer can adopt this work.

### Local customer, payment methods and feedback

Guest preview starts with a required blank email and no saved methods. Account
preview shows the account summary and never requests contact details, including
when an account has no email. Only the explicitly labelled account simulation
contains example masked cards and a FairCoin balance; real account identity does
not manufacture saved methods or wallet capability.

The method picker demonstrates cards, a bank/provider handoff, and FairCoin via
Peable balance or an external wallet. The balance and receive views use memory-only
fixtures. Their QR payloads are deliberately non-payable and contain no deposit
address. Simulating incoming funds changes only that fixture. There is no provider
tokenization, wallet key access, chain request, real quote, purchase attribution
by guest email, receipt delivery or entitlement grant in these previews.

A future guest-purchase claim must be explicit and authorized by a single-use,
receipt-linked token bound to the payment and merchant, plus an authenticated
account with verified email control. Present-day email ownership alone must not
automatically reveal or attach historical purchases. Claiming and any entitlement
grant must be idempotent backend operations; no such endpoint or email delivery
is implemented by this UI work.

Peable owns the supplied success/failure sound assets in its optional SDK UI
entry, retaining the original OGG files and AAC derivatives for native support.
Mention plays feedback once per completed simulated attempt, with a local sound
control enabled by default. Muting or closing cancels playback; device silent mode
is respected, and audio errors never block the result. Renders and navigating
back do not replay a completed sound. Bloom has no audio or payment side effects.

During the local processing state, backdrop, drag, Escape, native Back and the
host's close/back callbacks cannot dismiss checkout. Session teardown and
unmount still cancel the local work. The development “Slow confirmation” option
finishes with a simulated success after eight seconds, so it cannot trap the
preview indefinitely; this timer is not a real-payment confirmation mechanism.

The physical-order fixture alone offers an installment example: USD 28 total,
four USD 7 payments, zero example fees, and USD 7 due today. Selecting it changes
the review amount and final action to the amount due today while preserving the
USD 28 order total and item amount. Choosing a card restores USD 28 due today.
This finite schedule is separate from subscription renewal terms. No real
credit application, underwriting, provider eligibility or installment agreement
is created, and Mention Plus subscriptions do not advertise this option.
Product image sources use Bloom’s squircle image primitive. The physical sample
is a fictional Mention sticker pack using the existing Mention artwork.

Renewal and cancellation clauses appear through a Terms and conditions row only
when the request supplies them. The generic trial fixture provides sample
clauses under the overall local-preview disclosure; Mention subscriptions do
not acquire invented policies. Opening or leaving this view never records legal
acceptance or changes the checkout draft.

The realistic preview keeps one persistent Local preview badge in the host’s
noninteractive status layer, outside checkout. Customer-facing steps use ordinary
copy; fictional account mode is Alex Rivera at the reserved alex@example.test
address. These fixtures remain in memory and are not real account records.

FairCoin tender examples are explicit host fixtures: monthly 12 FAIR, annual
115 FAIR, physical order 56 FAIR, and trial zero. They are not live exchange
quotes. Wallet balance starts at 25 FAIR; an insufficient amount disables the
wallet action and shows the shortfall. The host-only Incoming funds toggle can
arrange one simulated arrival two seconds after opening the wallet’s own receive
view, setting that fixture to 150 FAIR once. Closing or leaving cancels the
pending event. No action labelled “I sent” establishes credit, and the QR payloads
remain intentionally non-payable despite the normal-looking masked UI. Choosing
FairCoin replaces an installment selection and restores the full physical order
amount; it does not invent a FairCoin-funded financing agreement.

### Buyer and merchant installment configuration

The local buyer flow can show merchant-enabled plans from an explicit provider
capability fixture. Merchant settings are a separate dialog below the host's
preview controls: enabled plan families, order amount limits, country/currency
filters, purchase types, and additional merchant messaging. These settings live
only in page memory and do not update a merchant account or provider dashboard.
The default keeps the physical order's four-payment plan.

Eligibility is the intersection of merchant preferences and each provider plan's
capability. Merchant settings cannot enable unavailable financing or currencies,
change an interest rate, guarantee customer approval, or override provider terms.
Subscription support is checked per plan; it is not a global assumption about
all deferred-payment products. Invalid limits and zero-due orders expose no plan.
Merchant text supplements provider disclosures rather than replacing them.

The local schedules preserve exact minor-unit totals. A $28.00 three-payment
fixture uses $9.34, $9.33 and $9.33; four payments use $7.00 each; the deferred
fixture has $0.00 due today and $28.00 due in 30 days. These are authored UI
fixtures, not live financing quotes or underwriting decisions. Production still
needs merchant settings APIs/storage, provider-account capability discovery,
customer/country eligibility, authoritative quote and disclosure retrieval,
provider approval and reconciliation. No financing configuration is activated by
this preview.

Implementation references: the [provider payment-method reference](https://docs.stripe.com/payments/klarna)
describes market-dependent plan families and constraints; the [provider checkout
presentation guide](https://docs.klarna.com/klarna-network-distribution/payment-presentation/present-klarna-in-the-checkout/)
requires transaction-specific presentation. The local policy deliberately keeps
merchant preference separate from that provider authority.

### Local wallet observations and installment options

The account review group and the wallet method use the same supplied observation. A public balance is independent of signing permission. The fixture account shows its explicit local balance; an actual Oxy account without a Peable public wallet descriptor shows **Balance unavailable**, not zero. Mention has no existing account-xpub bridge: Oxy's billing ledger and partial social receive-address totals are not a whole FairCoin wallet balance. The SDK accepts ready/loading/error/unavailable observations and optional host retry/connect capabilities; it never fetches or accepts a signing key here.

Merchant preview settings only narrow explicit provider capability fixtures. The buyer compares four payments, three payments with a correctly allocated first-payment remainder, or a deferred payment. Dates use the fixture business date 2026-11-03, not a locale-derived country. Quotes distinguish order value, due today, fees, interest and total repayable. Changing the order, merchant policy or decision clears the old selection. Pending, rejected and unavailable decisions cannot become payable selections. No APR, autopay agreement or provider approval is invented when the supplied capabilities omit it; merchant terms open a separate screen and do not imply consent.

External FAIRWallet payments now open the waiting QR/address step directly. The local Incoming funds switch drives a separate simulated transfer observation through detected, confirming and completion; there is no second Pay click and no “I sent it” credit. Waiting can be cancelled, confirmation uses the existing dismissal lock, and closing cancels pending work. The frozen request has a full nonpayable preview string shared by the displayed address, copy action and QR. The wallet's own receive/top-up payload is different and never completes a merchant payment. Real integration still requires authoritative intent observations and an actual payable address from the provider; this local fixture does not monitor the chain.

Numeric tax in this local preview is explicitly quoted fixture data: monthly 557 + 42 = 599 cents, annual 5350 + 400 = 5750 cents, and the physical order 2600 + 200 = 2800 cents. The amounts are inclusive and do not increase the stated total. They are not a tax rate, registration determination or live Peable Tax result. Unsupported prices show calculation pending; production must supply a fresh authoritative breakdown when taxable location changes. The SDK/Bloom request only presents supplied amounts.

Method selection advances to remaining prerequisites and then an explicit payment confirmation; it never automatically charges a saved card or returns the buyer to the initial order summary. External transfers collect those prerequisites before starting their waiting request. While waiting, the footer ring spins but cancellation remains available; after detection, confirmation blocks dismissal. The method name is FAIRWallet and its page is Pay with FairCoin.

Validation of this iteration uses the local web preview and shared component tests. Native-device Surface appearance, clipboard, audio and gesture behavior still require a device run; web screenshots are not native verification.

### One embedded checkout, environment-specific processing

Normal `/plus` has one Peable checkout and no test-versus-preview selector.
Development creates a real monthly or annual test subscription through the
existing billing service. Its guarded loopback bootstrap returns a payer-scoped
binding in React memory; no credential is placed in a URL or storage. Retry uses
the same operation key, duplicate presses are blocked, and a failed bootstrap
shows a canonical Bloom error toast without falling back to simulation. The
small development badge is outside the checkout flow.

`PeableEmbeddedCheckout` is transport-neutral: its binding declares the gateway,
payer capability, Peable mode (`livemode`) and authoritative subscription terms.
The same view checks that the intent and the provider key are of that mode. Its numeric tax breakdown,
when supplied, comes from the actual invoice; preview tax fixtures are never
reused. It serializes readiness polling and only completes when the first payment
has succeeded, the invoice is paid and the subscription is active. No development
payment grants the real user's Mention Plus access.

The product view uses Bloom's CardForm in both cases. In actual payment handling,
only its number, expiry and security-code slots contain secure provider-origin
fields; country/postcode, labels and chrome remain Bloom. Continue tokenizes
without charging. A separate Bloom confirmation displays masked metadata and
requires explicit Pay. The prepared token stays inside a disposable memory-only
authorization, survives field unmount, and never becomes a saved-card claim. The
processor handles authentication while the checkout blocks dismissal. Payment
success is never inferred from tokenization or client confirmation alone.

The developer fixtures now live only at `/checkout-playground`, guarded by the
existing development/loopback opt-in. Product checkout does not import or select
the simulated controller. Production still needs an equivalent authoritative
embedded payer binding from the deployed central billing integration; the local
harness is not a production credential service or a replacement entitlement
system. No provider mode is a buyer preference.

### Physical-order details and reward UI preview

Only the explicit physical-order development scenario at `/checkout-playground` now keeps the completed flow open
and shows an order view. Mention Plus and actual provider tests retain their
existing completion behavior. The view uses Bloom's `OrderStatusBar` and
`OrderStatusTimeline` with the selected fixture quote: an immediate card payment
shows USD 28 paid and zero remaining; four installments show USD 7 paid and USD
21 remaining with three scheduled payments. The optional early-payment and order
action callbacks are absent until a host can genuinely perform them.

A fictional, order-bound gift fixture follows the supplied reference flow:
optional introduction, at least two interests, two own-brand offer choices,
full conditions, explicit confirmation, then the selected gift. It uses the
existing Mention artwork through Bloom's squircle image primitive, not imagery
copied from another brand. One local in-memory claim is allowed per order;
expired/ineligible offers fail closed and never change payment totals. Dismissing
this flow does not reverse the payment. No fulfillment, external reward claim,
email, persisted gift or entitlement is created. The single persistent Local
preview badge identifies this scenario.

Real reward catalogues, merchant configuration, eligibility decisions and
fulfillment remain future services supplied by Peable's merchant workspace. The
controlled SDK component receives that data; Mention does not become a reward
provider. Actual provider card tests still use secure provider-hosted fields,
with Peable/Bloom owning the surrounding method navigation and checkout.

### Local recurring-payment verification

The unified local checkout was verified against actual provider TEST subscriptions:
USD 5.99 monthly, USD 57.50 annually, issuer authentication, and a declined card
followed by a successful retry on the same payment intent and subscription.
Continue created only an opaque payment-method token; explicit Pay performed the
confirmation. Completion waited for the signed Peable settlement plus a paid
invoice and active subscription, including after authentication. The retry used
one bootstrap operation and did not create another subscription.

Subscribe captures the already validated catalogue offer and opens that review in
the single Bloom checkout immediately. The explicit click starts preparation in
parallel; visiting the page creates no subscription. A separately scoped read-only
warmup fetches the gateway's actual public key, method capabilities and expiring
price configuration, and warms the cached provider script. It creates no intent,
customer or subscription and contains no payer secret. With valid configuration,
the buyer can select a method and type into secure card fields immediately while
preparation continues. Card Continue waits for both complete fields and matching
payer authority; no Pay action is permitted before the currency, amount, cadence,
merchant and provider key match. The same secure fields retain their contents when
the real payer action arrives. Expired or mismatched configuration never supplies
authority or an invented payment method.
The same sheet stays mounted when ready; no intermediate loading dialog is shown.
Dismissal aborts preparation and ignores late replies. Account/session/offer changes
remove the old review, and retry retains its scoped operation key. Bootstrap errors
use a toast rather than a simulated fallback or changed price.
Bank, installment and FairCoin options remain visible with their actual missing
configuration explained. The card adapter's provider restriction does not remove
Peable's other payment methods. Their live capabilities, the account-wallet bridge,
and real Mention Plus entitlement activation are not provided by this local test.

## Production release boundary

The reusable Bloom/Peable checkout is published independently of activating a
commercial offer. Production keeps the existing catalogue launch gate: an
unavailable offer displays Coming soon and cannot initiate payment. A configured
offer continues through the authenticated Oxy `startProductPlanCheckout` flow and
its validated hosted checkout URL until central billing supplies an embedded
payer binding. Development alone uses the guarded loopback test harness.

At Oxy main `d2a80c156`, `PersonalPlanCheckoutResult` exposes pending intent ID and
an optional HTTPS checkout URL, not a payer capability or embedded readiness
endpoint. Its Peable adapter creates or renews hosted billing sessions. Replacing
that production transport requires an authenticated, account/offer-bound contract
extension across Oxy contracts/core/API and Peable billing, plus authoritative
paid-invoice/subscription observation and the existing entitlement reconciliation.
Neither client-side confirmation nor the local test endpoint can substitute for
those authorities. Provider, merchant and fiscal activation remain separate from
shipping the UI; this release does not enable a live sale or grant access.
