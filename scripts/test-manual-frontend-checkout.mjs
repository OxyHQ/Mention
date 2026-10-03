import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseDocument } from 'yaml';

const workflow = parseDocument(readFileSync('.github/workflows/deploy-frontends.yml', 'utf8')).toJS();
const expectedCheckouts = process.cwd().includes('/Mention/') ? 3 : 5;
function validate(value) {
  let count = 0;
  for (const job of Object.values(value.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('actions/checkout@')) continue;
      assert.equal(step.with.ref, '${{ github.sha }}');
      assert.equal(step.if, undefined);
      count++;
    }
  }
  assert.equal(count, expectedCheckouts);
  const sha = 'a'.repeat(40);
  const github = {
    event_name: 'workflow_run', ref: 'refs/heads/main', sha, repository: 'OxyHQ/fixture',
    event: { workflow_run: { head_sha: sha, conclusion: 'success', event: 'push',
      head_repository: { full_name: 'OxyHQ/fixture' }, head_branch: 'main' } },
  };
  function admits(context, hold = 'false') {
    return runInNewContext(value.jobs.scope.if, { github: context,
      vars: { OXY_1519_ROLLOUT_HOLD: hold } }, { timeout: 100 });
  }
  assert.equal(admits(github), true);
  assert.equal(admits(github, 'true'), false);
  for (const change of [
    { head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }, { event: 'pull_request' },
    { head_repository: { full_name: 'other/repo' } }, { head_branch: 'feature' },
  ]) assert.equal(admits({ ...github, event: { workflow_run: { ...github.event.workflow_run, ...change } } }), false);
  assert.equal(admits({ ...github, event_name: 'workflow_dispatch' }), true);
  assert.equal(admits({ ...github, event_name: 'workflow_dispatch', ref: 'refs/heads/feature' }), false);
  if (value.on.push) assert.equal(admits({ ...github, event_name: 'push' }), true);
}
validate(workflow);
const stale = structuredClone(workflow);
stale.jobs.scope.if = stale.jobs.scope.if.replace('github.event.workflow_run.head_sha == github.sha &&', '');
assert.throws(() => validate(stale));
const checkout = structuredClone(workflow);
Object.values(checkout.jobs).find(job => job.steps?.some(step => step.uses?.startsWith('actions/checkout@')))
  .steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref = '${{ env.DEPLOY_SHA }}';
assert.throws(() => validate(checkout));
console.log(`${expectedCheckouts} immutable event-SHA checkouts; current/stale/manual/hold/foreign/failed CI controls and two mutations PASS`);
