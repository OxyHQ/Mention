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
