# Expo Router 57.0.18

The experimental stack currently ignores `contentStyle` and hardcodes a white
scene. Mention's Bloom AppShell owns the central surface, including its scoped
profile color. The router patch removes that competing fill and keeps its
existing `headerShown` correction. Route content and opaque modal surfaces still
own their semantic backgrounds; transparency only affects the navigator wrapper.
The npm package ships the compiled implementation, not its TypeScript source.
Remove this hunk when upstream supports transparent scene styling. This does not
claim physical-device validation: verify Android rendering after installation.
