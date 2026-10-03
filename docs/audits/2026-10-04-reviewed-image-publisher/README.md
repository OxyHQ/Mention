# ECR publisher classification

The canonical workflow gate previously classified every AWS credential use as
an ECS deployment. The new artifact-only publisher therefore failed the current-main
shell check (and, in CrowdSource, ECS APP/container/cluster pins). It now has one
closed classification: exact filename AND SHA-256 of the reviewed workflow,
Python source guard/ECR verifier, and repository recipe. Parsed manual-only,
required expected SHA, main ref, native ARM, and guard→vacancy→verify constraints
are also checked. Any input drift fails the exception and retains all ordinary
AWS deployment guards; other filenames never qualify. No runtime, template,
role, scope or deployment behavior changes.

The helper's source guard compares expected SHA, GitHub main dispatch SHA, clean
checkout and Dockerfile hash. It does not claim a remote-current-main check
during publication. Root promotion independently requires current-main source
and authenticated image/config digest. The old ECS deployment guards still
require their pre-build/pre-deploy main checks.

The canonical `bun run validate:workflows` passes and now invokes 13 classification
controls, including changed workflow/helper/recipe, push trigger, missing SHA,
x64 runner, missing main/guard and injected ECS/SSM commands. These are local
source checks, not an image publication or production execution.
