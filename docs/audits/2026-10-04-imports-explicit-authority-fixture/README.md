# Mention imports: explicit authority in the HTTP/SQL fixture

The old fixture expected an internal service token plus user header to authorize imports without an explicit Oxy grant. Published core4.2 correctly denies that request. The unchanged original fixture produced 19 failures and3 passes; its exact bytes and log are retained here.

The corrected fixture keeps all22 existing domain cases and their assertions. It supplies explicit synthetic grant responses only for Move/Alice, Move/Bob, and Other/Alice through the OxyServer.verifyActingAs network boundary. It asserts cache:false and credential/owner/environment from the verified token. Other/Alice is deliberately authorized at that boundary so the application-specific IMPORT_CALLER_NOT_ALLOWED assertion still tests Mention's gate. No middleware, application runtime or production grant changed.

A new negative removes the grant and checks HTTP403/SERVICE_ACTING_AS_UNAUTHORIZED before any post or import row exists. Real EdDSA JWT/data-JWKS verification, the published core source mapped by Vitest, real Mention routes/writers and disposable PostgreSQL remain in use. The session fixture retains its pre-existing req.user simulation. These controls prove Mention's fixture and domain behavior, not live Oxy consent or production grant issuance.

Final23/23 tests and backend tsc --noEmit pass. Both own PG17 processes were verified by PID/executable/data/port/socket before testing and stopped afterwards. The proof binds the source commit, original fixture, logs, harness and sampled published core source bytes. CI/image/main promotion remain separate operational gates.
