import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
const workflow=parseDocument(readFileSync('.github/workflows/deploy-frontends.yml','utf8')).toJS();
let pairs=0;
for(const job of Object.values(workflow.jobs)) {
 const steps=job.steps??[];
 for(let i=0;i<steps.length;i++) {
  const step=steps[i];
  if(!step.uses?.startsWith('actions/checkout@'))continue;
  assert.equal(step.if,"github.event_name != 'workflow_dispatch'");
  assert.equal(step.with.ref,'${{ env.DEPLOY_SHA }}');
  const manual=steps[++i];
  assert.equal(manual.if,"github.event_name == 'workflow_dispatch'");
  assert.equal(manual.with.ref,'${{ github.sha }}');
  assert.deepEqual({...manual,if:step.if,with:{...manual.with,ref:step.with.ref}},step);
  pairs++;
 }
}
assert.equal(pairs,3);
console.log(`${pairs} manual checkout pairs: immutable event SHA; original nonmanual configuration preserved`);
