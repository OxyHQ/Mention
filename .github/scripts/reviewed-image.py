"""The reviewed production image: one pin, checked at PR time and refused at deploy time.

`reviewed-images.json` names each production image recipe and pins ONE hash,
`buildInputsSha256`, over everything that decides what the image build may see
and do without being application code:

  * the recipe's Dockerfile bytes, build context and target, and
  * both ignore files BuildKit can apply to that build: `<context>/.dockerignore`
    and the per-Dockerfile `<dockerfile>.dockerignore`, which wins over it.
    An ignore file that does not exist is hashed as absent, so adding one is a
    change too.

That pin is the only place the value is written down. Every consumer recomputes
it from the files:

  check   CI, on every pull request: every recipe's inputs still match its pin,
          every recipe is guarded by a workflow, and no workflow hardcodes a hash
          label. A Dockerfile or .dockerignore change without a re-pin fails here,
          before merge, instead of stranding the pin on main.
  guard   the deploy, immediately before it builds: refuses a recipe whose inputs
          differ from the pin, and hands the build its Dockerfile, context and
          target, and the label values, from the same computation. Nothing is
          built or pushed when it refuses.
  pin     the owner's re-pin after reviewing a change: rewrites the one field.

Standard library only; it runs before any dependency is installed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

CONFIG = Path('.github/scripts/reviewed-images.json')
WORKFLOWS = Path('.github/workflows')
SCHEME = 'oxy-build-inputs/v1'
RECIPE_FIELDS = {'name', 'ecrRepository', 'dockerfile', 'context', 'target', 'buildInputsSha256'}
# A hash label spelled out in a workflow is a second copy of the pin, and the
# first one-sided re-pin makes the two disagree. Labels come from `guard`.
HARDCODED_LABEL = re.compile(r'io\.oxy\.[a-z0-9.-]*sha256=[0-9a-f]{64}')


class Rejected(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def repo_path(value, what):
    """A repository-relative POSIX path that cannot leave the checkout."""
    require(isinstance(value, str) and value, what + ' must be a path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in value, what + ' escapes the repository: ' + value)
    return path


def load(root):
    config = json.loads((root / CONFIG).read_text())
    require(isinstance(config, dict) and set(config) == {'repository', 'recipes'}, 'Unexpected configuration fields')
    repository = os.environ.get('GITHUB_REPOSITORY')
    require(not repository or config['repository'] == repository, 'Configuration is for ' + str(config['repository']) + ', not ' + str(repository))
    recipes = config['recipes']
    require(isinstance(recipes, list) and recipes, 'No recipes')
    names = [r.get('name') for r in recipes if isinstance(r, dict)]
    require(len(names) == len(recipes) and len(set(names)) == len(names), 'Recipe names must be unique')
    for r in recipes:
        require(set(r) == RECIPE_FIELDS, 'Recipe ' + str(r.get('name')) + ' fields differ from ' + ', '.join(sorted(RECIPE_FIELDS)))
        require(isinstance(r['name'], str) and re.fullmatch(r'[a-z0-9-]+', r['name']), 'Invalid recipe name')
        require(isinstance(r['ecrRepository'], str) and re.fullmatch(r'oxy/[a-z0-9-]+', r['ecrRepository']), 'Invalid ECR repository for ' + r['name'])
        require(r['target'] is None or (isinstance(r['target'], str) and re.fullmatch(r'[A-Za-z0-9_.-]+', r['target'])), 'Invalid target for ' + r['name'])
        require(isinstance(r['buildInputsSha256'], str) and re.fullmatch(r'[0-9a-f]{64}', r['buildInputsSha256']), 'Malformed pin for ' + r['name'])
        repo_path(r['dockerfile'], 'dockerfile')
        repo_path(r['context'], 'context')
    return config


def build_inputs(root, recipe):
    """The canonical description of what this recipe's build is controlled by."""
    dockerfile = repo_path(recipe['dockerfile'], 'dockerfile')
    context = repo_path(recipe['context'], 'context')
    paths = sorted({str(dockerfile), str(context / '.dockerignore'), str(dockerfile) + '.dockerignore'})
    files = {}
    for p in paths:
        f = root / p
        files[p] = sha256(f.read_bytes()) if f.is_file() else None
    require(files[str(dockerfile)] is not None, 'Dockerfile is missing: ' + str(dockerfile))
    return {'scheme': SCHEME, 'dockerfile': str(dockerfile), 'context': str(context), 'target': recipe['target'], 'files': files}


def inputs_sha256(root, recipe):
    canonical = json.dumps(build_inputs(root, recipe), sort_keys=True, separators=(',', ':'))
    return sha256(canonical.encode())


def mismatch(root, recipe):
    actual = inputs_sha256(root, recipe)
    if actual == recipe['buildInputsSha256']:
        return None
    files = build_inputs(root, recipe)['files']
    return (recipe['name'] + ': build inputs ' + actual + ' differ from the reviewed pin ' + recipe['buildInputsSha256']
            + ' (inputs: ' + ', '.join(p + ('' if h else ' [absent]') for p, h in files.items()) + ')'
            + '. Review the change, then run: python3 .github/scripts/reviewed-image.py pin')


def strip_comments(text):
    """YAML comments: a `#` at the start of a line or after whitespace, to the end of it."""
    return '\n'.join(re.sub(r'(^|\s)#.*$', '', line) for line in text.splitlines())


def workflow_texts(root):
    directory = root / WORKFLOWS
    files = sorted(list(directory.glob('*.yml')) + list(directory.glob('*.yaml'))) if directory.is_dir() else []
    return {str(f.relative_to(root)): f.read_text() for f in files}


def check(root):
    config = load(root)
    problems = [m for m in (mismatch(root, r) for r in config['recipes']) if m]
    workflows = workflow_texts(root)
    for name, text in workflows.items():
        for literal in HARDCODED_LABEL.findall(text):
            problems.append(name + ': hardcoded hash label ' + literal[:40] + '...; take it from `reviewed-image.py guard`')
    any_guard = re.compile(r'reviewed-image\.py\s+guard\s+--recipe\s+[a-z0-9-]+')
    for name, text in workflows.items():
        # A build that takes its inputs from a guard it no longer runs gets
        # empty outputs, and build-push-action then falls back to its OWN
        # defaults: an unreviewed build, not a refusal. So every workflow that
        # consumes the outputs must run the guard itself; one guarded workflow
        # elsewhere does not cover it.
        if 'steps.reviewed.outputs.' in strip_comments(text) and not any_guard.search(strip_comments(text)):
            problems.append(name + ': builds from `steps.reviewed.outputs` but runs no `reviewed-image.py guard`')
    live = '\n'.join(strip_comments(t) for t in workflows.values())
    for r in config['recipes']:
        guard = re.compile(r'reviewed-image\.py\s+guard\s+--recipe\s+' + re.escape(r['name']) + r'(?![a-z0-9-])')
        if not guard.search(live):
            problems.append(r['name'] + ': no workflow runs `reviewed-image.py guard --recipe ' + r['name'] + '` before building it')
    if problems:
        raise Rejected('\n'.join(problems))
    for r in config['recipes']:
        print(json.dumps({'recipe': r['name'], 'buildInputsSha256': r['buildInputsSha256'], 'reviewed': True}))


def guard(root, name, output):
    config = load(root)
    matches = [r for r in config['recipes'] if r['name'] == name]
    require(len(matches) == 1, 'Recipe not registered: ' + name)
    r = matches[0]
    problem = mismatch(root, r)
    require(problem is None, problem or '')
    tree = subprocess.run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root, capture_output=True, text=True, timeout=30, check=False)
    require(tree.returncode == 0 and re.fullmatch(r'[0-9a-f]{40}', tree.stdout.strip()), 'Cannot resolve the source tree')
    values = {
        'dockerfile': r['dockerfile'],
        'context': r['context'],
        'target': r['target'] or '',
        'ecr_repository': r['ecrRepository'],
        'build_inputs_sha256': r['buildInputsSha256'],
        'source_tree': tree.stdout.strip(),
    }
    if output:
        with open(output, 'a') as out:
            out.writelines(k + '=' + v + '\n' for k, v in values.items())
    print(json.dumps({'recipe': name, 'reviewed': True, **values}))


def pin(root, only):
    """Rewrite the pins in place, touching nothing but the hash values."""
    config = load(root)
    text = (root / CONFIG).read_text()
    changed = []
    for r in config['recipes']:
        if only and r['name'] != only:
            continue
        new = inputs_sha256(root, r)
        old = r['buildInputsSha256']
        if new == old:
            continue
        require(text.count('"' + old + '"') == 1, 'Pin for ' + r['name'] + ' is not unique in the file; edit it by hand')
        text = text.replace('"' + old + '"', '"' + new + '"')
        changed.append({'recipe': r['name'], 'from': old, 'to': new})
    require(not only or any(r['name'] == only for r in config['recipes']), 'Recipe not registered: ' + str(only))
    (root / CONFIG).write_text(text)
    print(json.dumps({'repinned': changed}))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('phase', choices=['check', 'guard', 'pin'])
    parser.add_argument('--recipe')
    parser.add_argument('--root', default='.')
    args = parser.parse_args(argv)
    root = Path(args.root)
    try:
        if args.phase == 'check':
            check(root)
        elif args.phase == 'guard':
            require(args.recipe, 'guard needs --recipe')
            guard(root, args.recipe, os.environ.get('GITHUB_OUTPUT'))
        else:
            pin(root, args.recipe)
    except Rejected as error:
        for line in str(error).splitlines():
            print('::error::' + line, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
