"""Proves reviewed-image.py can fail: every input it claims to cover, covered.

Run: python3 -m unittest discover -s .github/scripts -p test_reviewed_image.py
"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('reviewed_image', Path(__file__).with_name('reviewed-image.py'))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

GUARDED = 'jobs:\n  deploy:\n    steps:\n      - run: python3 -B .github/scripts/reviewed-image.py guard --recipe api\n'


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.saved_env = {k: os.environ.pop(k, None) for k in ('GITHUB_REPOSITORY', 'GITHUB_OUTPUT')}
        self.write('svc/Dockerfile', 'FROM scratch\nCOPY . /app\n')
        self.write('.dockerignore', 'node_modules\n.env\n')
        self.write('.github/workflows/deploy.yml', GUARDED)
        self.write('.github/scripts/reviewed-images.json', json.dumps({
            'repository': 'OxyHQ/Example',
            'recipes': [{'name': 'api', 'ecrRepository': 'oxy/example', 'dockerfile': 'svc/Dockerfile', 'context': '.', 'target': None, 'buildInputsSha256': '0' * 64}],
        }, indent=2) + '\n')
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], cwd=self.root, check=True)
        self.assertEqual(gate.main(['pin', '--root', str(self.root)]), 0)
        self.assertEqual(self.run_check(), 0, 'a freshly pinned fixture must pass, or every failure below is vacuous')

    def tearDown(self):
        for k, v in self.saved_env.items():
            if v is not None:
                os.environ[k] = v
        self.tmp.cleanup()

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def config(self):
        return json.loads((self.root / '.github/scripts/reviewed-images.json').read_text())

    def set_recipe(self, **fields):
        config = self.config()
        config['recipes'][0].update(fields)
        self.write('.github/scripts/reviewed-images.json', json.dumps(config, indent=2) + '\n')

    def run_check(self):
        return gate.main(['check', '--root', str(self.root)])


class CoveredInputs(Fixture):
    def test_dockerfile_change_without_repin_fails(self):
        self.write('svc/Dockerfile', 'FROM scratch\nCOPY . /app\nUSER root\n')
        self.assertEqual(self.run_check(), 1)

    def test_context_dockerignore_change_fails(self):
        self.write('.dockerignore', 'node_modules\n')
        self.assertEqual(self.run_check(), 1)

    def test_deleting_the_context_dockerignore_fails(self):
        (self.root / '.dockerignore').unlink()
        self.assertEqual(self.run_check(), 1)

    def test_adding_a_per_dockerfile_dockerignore_fails(self):
        # BuildKit prefers <Dockerfile>.dockerignore over the context's, so its
        # appearance can re-admit `.env` without touching .dockerignore at all.
        self.write('svc/Dockerfile.dockerignore', 'node_modules\n')
        self.assertEqual(self.run_check(), 1)

    def test_an_empty_per_dockerfile_dockerignore_fails(self):
        # Empty is not absent: an empty override ignores NOTHING, so `.env`
        # and every other file .dockerignore keeps out reach the build again.
        self.write('svc/Dockerfile.dockerignore', '')
        self.assertEqual(self.run_check(), 1)

    def test_target_change_fails(self):
        self.set_recipe(target='debug')
        self.assertEqual(self.run_check(), 1)

    def test_context_change_fails(self):
        self.set_recipe(context='svc')
        self.assertEqual(self.run_check(), 1)

    def test_application_code_is_not_an_input(self):
        self.write('svc/server.ts', 'export {}\n')
        self.assertEqual(self.run_check(), 0)


class OneSourceOfTruth(Fixture):
    def test_repin_restores_and_touches_only_the_hash(self):
        before = (self.root / '.github/scripts/reviewed-images.json').read_text()
        self.write('svc/Dockerfile', 'FROM scratch\n')
        self.assertEqual(self.run_check(), 1)
        self.assertEqual(gate.main(['pin', '--root', str(self.root)]), 0)
        after = (self.root / '.github/scripts/reviewed-images.json').read_text()
        self.assertEqual(self.run_check(), 0)
        changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
        self.assertEqual(len(changed), 1)
        self.assertIn('buildInputsSha256', changed[0][1])

    def test_hardcoded_hash_label_in_a_workflow_fails(self):
        self.write('.github/workflows/publish.yml', 'labels: io.oxy.build-inputs.sha256=' + 'a' * 64 + '\n')
        self.assertEqual(self.run_check(), 1)

    def test_unguarded_recipe_fails(self):
        self.write('.github/workflows/deploy.yml', 'jobs: {}\n')
        self.assertEqual(self.run_check(), 1)

    def test_guard_only_in_a_comment_does_not_count(self):
        self.write('.github/workflows/deploy.yml', '# python3 .github/scripts/reviewed-image.py guard --recipe api\n')
        self.assertEqual(self.run_check(), 1)

    def test_guard_for_a_longer_name_does_not_count(self):
        self.write('.github/workflows/deploy.yml', GUARDED.replace('--recipe api', '--recipe api-worker'))
        self.assertEqual(self.run_check(), 1)

    def test_a_second_workflow_that_lost_its_guard_fails(self):
        # One guarded workflow must not cover another that builds the same
        # recipe from guard outputs it no longer produces.
        self.write('.github/workflows/one-shot.yml', 'jobs:\n  run:\n    steps:\n      - run: true # reviewed-image.py guard --recipe api\n'
                   '      - uses: docker/build-push-action@x\n        with:\n          file: ${{ steps.reviewed.outputs.dockerfile }}\n')
        self.assertEqual(self.run_check(), 1)

    def test_a_per_recipe_step_id_that_lost_its_guard_fails(self):
        # Two recipes in one job need distinct step ids (`reviewed_api`,
        # `reviewed_worker`); those consumers are covered too.
        self.write('.github/workflows/one-shot.yml', 'jobs:\n  run:\n    steps:\n'
                   '      - run: docker build -f "$F" .\n        env:\n          F: ${{ steps.reviewed_worker.outputs.dockerfile }}\n')
        self.assertEqual(self.run_check(), 1)

    def test_unknown_field_is_refused(self):
        self.set_recipe(dockerfileSha256='0' * 64)
        self.assertEqual(self.run_check(), 1)

    def test_path_escaping_the_checkout_is_refused(self):
        self.set_recipe(dockerfile='../Dockerfile')
        self.assertEqual(self.run_check(), 1)

    def test_configuration_for_another_repository_is_refused(self):
        os.environ['GITHUB_REPOSITORY'] = 'OxyHQ/Other'
        self.assertEqual(self.run_check(), 1)


class DeployGuard(Fixture):
    def guard(self):
        out = self.root / 'github-output'
        os.environ['GITHUB_OUTPUT'] = str(out)
        code = gate.main(['guard', '--recipe', 'api', '--root', str(self.root)])
        values = dict(line.split('=', 1) for line in out.read_text().splitlines()) if out.exists() else {}
        return code, values

    def test_outputs_come_from_the_pin_it_just_verified(self):
        code, values = self.guard()
        self.assertEqual(code, 0)
        self.assertEqual(values['build_inputs_sha256'], self.config()['recipes'][0]['buildInputsSha256'])
        self.assertEqual(values['build_inputs_sha256'], gate.inputs_sha256(self.root, self.config()['recipes'][0]))
        self.assertEqual(values['dockerfile'], 'svc/Dockerfile')
        self.assertEqual(values['context'], '.')
        self.assertEqual(values['target'], '')
        self.assertRegex(values['source_tree'], r'^[0-9a-f]{40}$')

    def test_refuses_unreviewed_inputs_and_hands_the_build_nothing(self):
        self.write('.dockerignore', '')
        code, values = self.guard()
        self.assertEqual(code, 1)
        self.assertEqual(values, {})

    def test_refuses_an_unregistered_recipe(self):
        os.environ['GITHUB_OUTPUT'] = str(self.root / 'github-output')
        self.assertEqual(gate.main(['guard', '--recipe', 'nope', '--root', str(self.root)]), 1)


if __name__ == '__main__':
    unittest.main()
