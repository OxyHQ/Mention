# Boost: paying to reach more people with your own post

A person can buy views for **their own post**. It is not an ad system: there are
no advertisers, campaigns or reserved slots. The promoted post travels through the
ordinary ranked feed, reaches people who would not otherwise see it, and carries a
small "Boosted" label.

In code and storage this is called **promotion** (`post_promotions`,
`services/promotion`, `MtnConfig.promotion`). "Boost" is what people read; it is
not used as an identifier because `boost` still means *repost* in stored values
and in the deprecated wire names until that rename completes.

**Status: built behind an off switch.** `MtnConfig.promotion.enabled` is `false`.
Nothing is purchasable and nothing is delivered until the payment capability, the
merchant and the prices are approved (see "What has to exist outside Mention").

## What is bought

A **tier** from `MtnConfig.promotion.tiers`: a number of impressions to be spent
over at most `durationHours`. Prices are never in Mention: they come from the
payment catalogue, and a client never sends one.

## Who may promote what

`services/promotion/eligibility.ts` is one pure function; each rule is a reason
code a client maps to copy:

- `not-owner`: only the author's own post;
- `not-original`: not a repost, quote or reply (that would spend money on
  someone else's words);
- `not-public`, `not-published`;
- `content-restricted`: anything the feed itself keeps out of discovery
  (sensitive, NSFW, behind a content warning). Payment never widens a gate;
- `audience-closed`: the author keeps posts inside an audience (non-public profile);
- `buyer-protected`: the account is under the protected age profile (oxy ADR
  0068), which never sees ranked feeds and so is never a buyer either;
- `already-promoted`: one open promotion per post, enforced by a partial unique
  index, so two concurrent purchases cannot both succeed.

## Data

- `post_promotions`: the purchase. `pending_payment → active → completed`, or
  `paused`, `canceled`, `refunded`. `paymentRef` only names the Peable invoice;
  **Peable stays the fiscal system of record**.
- `post_promotion_impressions`: the ledger, one row per viewer per UTC day. Its
  primary key is what makes a repeated report count once, so the billable number
  stays honest; it is also the frequency cap.

Deleting the post ends its promotion (`ON DELETE CASCADE`); erasing an account
deletes the buyer's promotions and the viewer's ledger rows
(`services/accountErasure`, `services/channelDeletion`).

## What has to exist outside Mention

Not done, and not Mention's to decide alone:

1. a charge and refund capability for Mention in oxy's first-party registry
   (`actsForPeople`, oxy ADR 0066), which is a PR in the oxy repo plus the seed
   workflow;
2. approval of Mention's merchant and offer binding in Peable;
3. the prices of the tiers.

No checkout, charge or test payment is created by this code while the switch is off.
