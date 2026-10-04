# Manual checkout provenance

Mention CodeQL flagged the env.DEPLOY_SHA checkout when the workflow gained
manual dispatch. The actual release guard already bound it to exact main, but
the checkout itself now represents that distinction: workflow_dispatch checks
out github.sha directly; only the existing nonmanual events use DEPLOY_SHA.
This also applies to CrowdSource's equivalent manual route. No alert is
suppressed and no token, scope, deployment or CI gate is changed. Remote
CodeQL results remain pending until the new source is scanned.

The local parsed-workflow check verifies every checkout pair and preserves all
other checkout inputs. The canonical workflow validator remains green, including
13 ECR-only publisher classification controls. No dispatch or registry install.
