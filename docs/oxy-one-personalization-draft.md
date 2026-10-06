# Oxy One Mention personalization draft

Mention consumes the central Oxy `User.personalization.mentionMono` contract:
`{ allowed: boolean, expiresAt: string | null }`. Oxy resolves eligible individual
subscriptions and configured, product-specific capability grants. Generic
`premium.isPremium` is not a Mention entitlement. Missing authority denies mono.

`mono` is Bloom's canonical monochrome preset identity. It is not an alias for
`monochrome`. `oxy` remains handle-owned, regardless of payment. All picker presets intersect
Oxy’s canonical `USER_PROFILE_COLOR_PRESETS`; Bloom-only `faircoin` is unavailable,
even to a matching handle, and a stored unsupported preset falls back to blue.

The private capability read uses SDK `users.me({cache:false})`, is keyed by current
account and session, is not persisted, checks returned subject identity, refreshes
every 15 seconds and on foreground. Network failure removes premium permission.
A one-second clock rechecks the server-supplied expiry locally. Account-switch,
sign-out, cancellation, and expired preferences fall back to free blue. This is
client rendering enforcement; Oxy independently validates canonical profile and
account theme writes, including direct API requests.

Mention's legacy `appearance.primaryColor` is a six-digit custom hex, not a preset
name. Its server rejects preset identities sent through this field; custom free
hex colors, translation, theme modes, notes/privacy are not paywalled. Custom hex
is not an identity-claim authority and is not converted into a premium preset.

No live catalogue or provider is configured by this draft. Deployment requires a
compatible published Oxy SDK with the optional uncached `users.me` read and the
personalization DTO/server policy. No source edits activate a purchase or grant.
