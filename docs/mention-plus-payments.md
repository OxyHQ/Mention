# Mention Plus payment window

Mention Plus remains included in the approved Oxy One bundle. Mention does not
create a second subscription authority, price catalogue or paid-access flag.

Subscribe opens a Bloom **Pay with Peable** dialog. The page and dialog both read
the selected offer from Oxy's published personal-plan catalogue; they show no
static replacement price when it is unavailable. Continue opens the authoritative
hosted payment URL in a browser popup on web or an in-app browser on native. The
hosted surface depends on the selected provider/rail; the dialog does not embed a
card form or sign a FairCoin payment itself.

## Deployment binding

Set these public build-time values only after the commercial owner has approved
the exact Oxy One offer and confirmed that its benefits include Mention Plus:

- `EXPO_PUBLIC_MENTION_PLUS_OFFER_ID`: the published Oxy personal offer ID.
- `EXPO_PUBLIC_MENTION_PLUS_OFFER_VERSION`: its exact positive integer version.

The central catalogue must be configured, allow purchases, and expose exactly one
matching personal Oxy One offer with an approved monthly USD price. The backend
must also accept that offer under its commercial eligibility rules and have the
Peable payment/tax/provider binding configured. These frontend values identify an
offer; they cannot activate it or bypass those gates. Never infer a binding from a
name, a displayed price or a generic premium flag. Changing benefits/version needs
a reviewed central offer and updated build configuration.

Without this binding or an available offer, Subscribe still opens the window and
explains that the subscription is unavailable. No checkout is created. The live
catalogue observed during implementation was empty; no production purchase or
entitlement activation has been demonstrated by this change.

## Payment outcomes and recovery

The operation key is saved before checkout creation, scoped by account, offer and
version. Browser Web Locks serialize the shared storage read/create across tabs;
web hosts without that API fail before checkout instead of risking replacement of
a recovery key. Native calls share an in-process creation promise. Interrupted
responses, duplicate clicks, popup blocking and dismissal retain the key. Check
payment status uses the same operation and never trusts a browser return URL.

Only an authoritative `fulfilled` response causes Mention's account-scoped
personalization query to refresh. The client never writes a paid entitlement.
Pending payment, closed checkout, unavailable offer, transport failure and a
payment requiring review are separate states. A review-required response offers
no new payment action. Account/session changes close the owned window and discard
old responses. Cleanup dismisses a native browser only while this dialog owns it.

This is Mention's first consumer of the Peable window flow, not a general-purpose
published SDK modal. Production acceptance still requires the approved binding,
backend deployment, web/native payment tests, and authoritative renewal,
cancellation and entitlement verification. No cryptocurrency sale or purchase
service is introduced.
