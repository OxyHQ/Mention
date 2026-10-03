#!/usr/bin/env python3
"""Read-only, exact-main CI gate for coordinated manual frontend releases."""
import json
import os
import re
import subprocess
import sys


def api(path):
    result = subprocess.run(['gh', 'api', path], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError('GitHub read failed')
    return json.loads(result.stdout)


def verify(env, read=api, head=None):
    repo = env.get('GITHUB_REPOSITORY', '')
    sha = env.get('EXPECTED_SHA', '')
    run_id = env.get('EXPECTED_CI_RUN_ID', '')
    workflow = env.get('EXPECTED_CI_WORKFLOW', '')
    if not re.fullmatch(r'OxyHQ/[A-Za-z0-9_.-]+', repo):
        raise ValueError('Unexpected repository')
    if env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Manual release must run on main')
    if env.get('OXY_1519_ROLLOUT_HOLD') == 'true':
        raise ValueError('Rollout hold is active')
    if not re.fullmatch('[0-9a-f]{40}', sha) or not re.fullmatch('[1-9][0-9]*', run_id):
        raise ValueError('Exact SHA and CI run ID are required')
    if workflow not in ('.github/workflows/ci.yml', '.github/workflows/checks.yml'):
        raise ValueError('Unexpected CI workflow')
    if env.get('GITHUB_SHA') != sha:
        raise ValueError('Dispatch SHA differs from reviewed source')
    if head is None:
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=15).strip()
    if head != sha or read(f'repos/{repo}/commits/main').get('sha') != sha:
        raise ValueError('Checkout or current main differs from reviewed source')
    run = read(f'repos/{repo}/actions/runs/{run_id}')
    if not (str(run.get('id')) == run_id and run.get('head_sha') == sha
            and run.get('path') == workflow and run.get('event') == 'push'
            and run.get('head_branch') == 'main' and run.get('status') == 'completed'
            and run.get('conclusion') == 'success'
            and run.get('repository', {}).get('full_name') == repo
            and run.get('head_repository', {}).get('full_name') == repo):
        raise ValueError('Exact source has no matching successful main CI run')
    return {'sourceSha': sha, 'ciRunId': run_id, 'workflow': workflow, 'repository': repo}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(os.environ), sort_keys=True))
    except (ValueError, OSError, subprocess.SubprocessError):
        print('Manual frontend provenance verification failed', file=sys.stderr)
        sys.exit(1)
