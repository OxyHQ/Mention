"""One recovery API archive, with authenticated candidate/CI guards and no AWS calls."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

REPO = 'OxyHQ/Mention'
PR = 1309
OPERATOR = 'NateIsern'
DOCKER_SHA = '03fd7ec3c3b5d436fd0e1c5d9471850992d3f32d045b849d98b8bfcb8034a2f8'
REQUIRED_JOBS = {'Build, lint and typecheck', 'Lockfile resolves cleanly from the base',
                 'Test backend (1/3)', 'Test backend (2/3)', 'Test backend (3/3)',
                 'Test mcp', 'Test frontend', 'Test shared-types', 'Frontend bundle budget'}


def require(value, message):
    if not value:
        raise ValueError(message)


def validate(env, pr, main, run, jobs, facts, now):
    require(now < datetime(2026, 10, 9, 22, tzinfo=timezone.utc), 'Recovery window expired')
    require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('GITHUB_REPOSITORY') == REPO
            and env.get('GITHUB_ACTOR') == OPERATOR, 'Explicit owner dispatch required')
    head, tree = env.get('EXPECTED_SOURCE_SHA', ''), env.get('EXPECTED_SOURCE_TREE', '')
    require(re.fullmatch('[a-f0-9]{40}', head) and re.fullmatch('[a-f0-9]{40}', tree), 'Full source/tree pins required')
    require(pr.get('number') == PR and pr.get('state') == 'open' and not pr.get('merged')
            and pr.get('head', {}).get('repo', {}).get('full_name') == REPO
            and pr.get('base', {}).get('repo', {}).get('full_name') == REPO
            and pr.get('base', {}).get('ref') == 'main', 'Closed same-repository recovery PR required')
    require(pr['head']['sha'] == head == env.get('GITHUB_SHA') == facts['head']
            and env.get('GITHUB_REF') == 'refs/heads/' + pr['head']['ref']
            and pr['head']['ref'] != 'main', 'Candidate head/ref differs')
    require(main.get('object', {}).get('sha') == facts['main'] and facts['mainAncestor']
            and facts['tree'] == tree and facts['clean'] and facts['dockerSha'] == DOCKER_SHA,
            'Clean authenticated source/tree/recipe required')
    require(str(run.get('id')) == env.get('CANDIDATE_CI_RUN_ID') and run.get('head_sha') == facts['ciHead']
            and facts['ciSourceEquivalent']
            and run.get('head_branch') == pr['head']['ref'] and run.get('status') == 'completed'
            and run.get('event') == 'pull_request' and run.get('path') == '.github/workflows/ci.yml'
            and run.get('repository', {}).get('full_name') == REPO
            and run.get('head_repository', {}).get('full_name') == REPO, 'Exact completed PR CI required')
    names = [job.get('name') for job in jobs]
    require(len(names) == len(set(names)) and REQUIRED_JOBS.issubset(names), 'CI jobs incomplete or duplicate')
    for job in jobs:
        require(job.get('status') == 'completed', 'CI job not terminal')
        if job['name'] in REQUIRED_JOBS:
            require(job.get('conclusion') == 'success', 'Required job not successful: ' + job['name'])
        elif job['name'] in {'Browser gate (e2e)', 'CI complete'}:
            require(job.get('conclusion') in {'success', 'failure'}, 'Browser/aggregate not evaluated')
        else:
            require(job.get('conclusion') in {'success', 'skipped'}, 'Other CI failure: ' + job['name'])
    # The exception admits building an archive, never a green aggregate or deployment.
    return {'kind': 'mention-api-recovery-candidate-archive-guard-v1', 'repository': REPO,
            'pullRequest': PR, 'sourceSha': head, 'sourceTreeSha': tree, 'mainSha': facts['main'],
            'dockerfile': 'packages/backend/Dockerfile', 'dockerfileSha256': DOCKER_SHA,
            'ciRunId': run['id'], 'ciSourceSha': run['head_sha'], 'ciSourceEquivalent': True, 'ciConclusion': run.get('conclusion'),
            'jobs': [{'name': job['name'], 'id': job.get('id'), 'conclusion': job['conclusion']} for job in jobs],
            'service': 'mention', 'platform': 'linux/arm64', 'awsPermissions': False,
            'mergeAuthorized': False, 'deploymentAuthorized': False}


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=45, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 8 * 1024 * 1024, 'Read-only source lookup failed')
    return result.stdout.decode().strip()


def gh(path):
    return json.loads(command(['gh', 'api', path]))


def main():
    env = dict(os.environ)
    run_id = env.get('CANDIDATE_CI_RUN_ID', '')
    require(re.fullmatch('[1-9][0-9]{1,19}', run_id), 'CI run pin required')
    pr = gh(f'repos/{REPO}/pulls/{PR}')
    main_ref = gh(f'repos/{REPO}/git/ref/heads/main')
    run = gh(f'repos/{REPO}/actions/runs/{run_id}')
    jobs = []
    for page in range(1, 11):
        batch = gh(f'repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100&page={page}')
        jobs.extend(batch['jobs'])
        if len(jobs) == batch['total_count']:
            break
    require(len(jobs) == batch['total_count'], 'Incomplete job pagination')
    git = lambda *args: command(['git', *args])
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', main_ref['object']['sha'], 'HEAD'], capture_output=True)
    facts = {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
             'main': git('rev-parse', main_ref['object']['sha']), 'mainAncestor': ancestor.returncode == 0,
             'clean': not git('status', '--porcelain', '--untracked-files=all'),
             'dockerSha': hashlib.sha256(Path('packages/backend/Dockerfile').read_bytes()).hexdigest()}
    ci_head = run.get('head_sha', '')
    require(re.fullmatch('[a-f0-9]{40}', ci_head), 'CI source malformed')
    changed = git('diff', '--name-only', ci_head, 'HEAD').splitlines()
    admitted = {'.github/workflows/publish-reviewed-images.yml', '.github/scripts/candidate-api-image.py', '.github/scripts/test-candidate-api-image.py', 'scripts/reviewed-image-publisher.mjs', 'scripts/test-reviewed-image-publisher.mjs'}
    facts.update(ciHead=ci_head, ciSourceEquivalent=set(changed).issubset(admitted))
    receipt = validate(env, pr, main_ref, run, jobs, facts, datetime.now(timezone.utc))
    directory = Path(env['RUNNER_TEMP']) / 'mention-api-candidate'
    directory.mkdir(mode=0o700, exist_ok=False)
    (directory / 'source-and-ci.json').write_text(json.dumps(receipt, indent=2) + '\n')
    with open(env['GITHUB_OUTPUT'], 'a') as output:
        output.write('source_tree=' + facts['tree'] + '\nproof_path=' + str(directory) + '\n')
    print(json.dumps({'candidateArchiveGuardPassed': True, 'sourceSha': facts['head'], 'ciRunId': run['id']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'candidateArchiveGuardPassed': False, 'reason': str(error) if isinstance(error, ValueError) else 'Lookup or source validation failed'}))
        raise SystemExit(1)
