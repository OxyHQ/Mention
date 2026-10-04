import copy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('candidate-api-image.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CandidateTests(unittest.TestCase):
    def fixture(self):
        head, tree, main, ci = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40
        return dict(env={'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': m.REPO,
                         'GITHUB_ACTOR': m.OPERATOR, 'EXPECTED_SOURCE_SHA': head,
                         'EXPECTED_SOURCE_TREE': tree, 'GITHUB_SHA': head,
                         'GITHUB_REF': 'refs/heads/task/candidate', 'CANDIDATE_CI_RUN_ID': '123'},
                    pr={'number': 1309, 'state': 'open', 'merged': False,
                        'head': {'sha': head, 'ref': 'task/candidate', 'repo': {'full_name': m.REPO}},
                        'base': {'ref': 'main', 'repo': {'full_name': m.REPO}}},
                    main={'object': {'sha': main}},
                    run={'id': 123, 'head_sha': ci, 'head_branch': 'task/candidate', 'status': 'completed',
                         'event': 'pull_request', 'path': '.github/workflows/ci.yml', 'conclusion': 'failure',
                         'repository': {'full_name': m.REPO}, 'head_repository': {'full_name': m.REPO}},
                    jobs=[{'name': name, 'status': 'completed', 'conclusion': 'success'} for name in sorted(m.REQUIRED_JOBS)]
                         + [{'name': name, 'status': 'completed', 'conclusion': 'failure'} for name in ['Browser gate (e2e)', 'CI complete']],
                    facts={'head': head, 'tree': tree, 'main': main, 'mainAncestor': True, 'clean': True,
                           'dockerSha': m.DOCKER_SHA, 'ciHead': ci, 'ciSourceEquivalent': True},
                    now=datetime(2026, 10, 4, tzinfo=timezone.utc))

    def test_build_archive_does_not_authorize_deploy_or_merge(self):
        value = m.validate(**self.fixture())
        self.assertFalse(value['deploymentAuthorized'])
        self.assertFalse(value['mergeAuthorized'])
        self.assertFalse(value['awsPermissions'])
        self.assertEqual(value['ciConclusion'], 'failure')

    def test_negative_controls(self):
        controls = [lambda f: f['env'].update(GITHUB_EVENT_NAME='push'),
                    lambda f: f['env'].update(GITHUB_ACTOR='someone'),
                    lambda f: f['pr']['head']['repo'].update(full_name='fork/Mention'),
                    lambda f: f['pr'].update(number=1310),
                    lambda f: f['pr'].update(state='closed'),
                    lambda f: f['env'].update(GITHUB_SHA='e' * 40),
                    lambda f: f['env'].update(GITHUB_REF='refs/heads/main'),
                    lambda f: f['facts'].update(tree='e' * 40),
                    lambda f: f['facts'].update(clean=False),
                    lambda f: f['facts'].update(mainAncestor=False),
                    lambda f: f['facts'].update(dockerSha='0' * 64),
                    lambda f: f['facts'].update(ciSourceEquivalent=False),
                    lambda f: f['run'].update(head_sha='e' * 40),
                    lambda f: f['run'].update(event='workflow_dispatch'),
                    lambda f: f['run'].update(status='in_progress'),
                    lambda f: f['jobs'].pop(0),
                    lambda f: f['jobs'].append(copy.deepcopy(f['jobs'][0])),
                    lambda f: f['jobs'][0].update(conclusion='failure'),
                    lambda f: f['jobs'].append({'name': 'Other', 'status': 'completed', 'conclusion': 'failure'}),
                    lambda f: f.update(now=datetime(2026, 10, 9, 22, tzinfo=timezone.utc))]
        for index, change in enumerate(controls):
            with self.subTest(control=index):
                fixture = self.fixture()
                change(fixture)
                with self.assertRaises(ValueError):
                    m.validate(**fixture)

    def test_workflow_is_archive_only_and_defaults_remain_closed(self):
        workflow = Path('.github/workflows/publish-reviewed-images.yml').read_text()
        job = workflow.split('  mention-api-recovery-candidate:\n', 1)[1]
        permissions = job.split('    permissions:\n', 1)[1].split('    env:\n', 1)[0]
        self.assertEqual(permissions, '      contents: read\n      actions: read\n      pull-requests: read\n')
        self.assertIn('          push: false\n', job)
        self.assertIn('          outputs: type=oci,', job)
        self.assertIn('          platforms: linux/arm64\n', job)
        self.assertNotIn('aws-actions/', job)
        self.assertNotIn('id-token:', job)
        self.assertNotIn('aws ', job)
        self.assertEqual(workflow.count("github.ref == 'refs/heads/main'"), 2)
        self.assertEqual(workflow.count('inputs.api_recovery_candidate != true'), 2)



if __name__ == '__main__':
    unittest.main(verbosity=2)
