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
For native builds, supply the same reviewed identities in the selected EAS build
environment before building; the hosted-web workflow does not configure native apps.
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
survive Back navigation. Fixed test cards contain only brand/last-four metadata;
no PAN or security-code input exists. Opt-in saved-card metadata stays in memory
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
The resolver refuses production, CI and non-loopback settings and is inactive
without the explicit flag. A published SDK version containing the optional UI
entry is still required before any production consumer can adopt this work.
