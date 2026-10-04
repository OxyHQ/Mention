# Review follow-up: expiry before dispatch

Two exact PostgreSQL fixtures fail against `0c0dfdf47`: expiry before the next
worker cycle, and expiry while the claim waits on a held content lock. Both make
zero SDK calls but leave a cost-uncertain row. The unchanged fixture passes
after checking admission before and after the claim and releasing unsent work.
A typed local refusal also covers the final pre-SDK boundary; ambiguous provider
errors still retain their original claim. Baseline classification completes,
and receipt maintenance remains independent of new-admission expiry.

Both focused controls and 134 related tests in four suites pass, as does the
canonical backend build. All three owned PostgreSQL instances are stopped.

The root review also identified an overstatement in the earlier binding
description: deploymentId is review metadata only. Neither public decisions
responses nor usage records attest an exact deployment. Activation therefore
requires independent evidence that the matching Oxy resolver policy pins the
reviewed deployment before dispatch; storing the string does not enforce this.
The source approval is still absent and every release blocker remains closed.
