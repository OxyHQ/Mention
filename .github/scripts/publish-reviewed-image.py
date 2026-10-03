"""Closed source guards and ECR readback for the manual ARM publisher; no deployment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import urllib.request

ACCOUNT = '237343248947'
REGION = 'us-west-2'
REGISTRY = ACCOUNT + '.dkr.ecr.' + REGION + '.amazonaws.com'
MANIFEST_TYPES = ['application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json']


class Rejected(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=60, check=False)
    require(result.returncode == 0, 'Command failed: ' + args[0])
    return result.stdout.decode()


def aws(*args):
    return json.loads(run(['aws', *args, '--region', REGION, '--output', 'json', '--no-cli-pager']))


def git(*args):
    return run(['git', *args]).strip()


def recipe_for(name):
    config = json.loads(Path('.github/scripts/reviewed-images.json').read_text())
    require(set(config) == {'repository', 'recipes'}, 'Unexpected configuration fields')
    require(config['repository'] == os.environ['GITHUB_REPOSITORY'], 'Repository differs')
    recipes = [r for r in config['recipes'] if r['name'] == name]
    require(len(recipes) == 1, 'Recipe not uniquely registered')
    r = recipes[0]
    require(set(r) == {'name', 'services', 'ecrRepository', 'dockerfile', 'dockerfileSha256', 'target', 'tagSuffix', 'cacheScope'}, 'Unexpected recipe fields')
    require(re.fullmatch(r'oxy/[a-z0-9-]+', r['ecrRepository']) and re.fullmatch(r'[a-z0-9-]+', r['name']), 'Invalid closed recipe')
    require(r['tagSuffix'] in ('', '-api', '-worker') and re.fullmatch(r'[a-f0-9]{64}', r['dockerfileSha256']), 'Malformed recipe pins')
    return config, r


def source_guard(name):
    config, r = recipe_for(name)
    head = os.environ.get('GITHUB_SHA', '')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Manual main execution required')
    require(re.fullmatch(r'[a-f0-9]{40}', head) and head == os.environ.get('EXPECTED_SOURCE_SHA') and git('rev-parse', 'HEAD') == head, 'Expected source SHA differs')
    require(not git('status', '--porcelain', '--untracked-files=all'), 'Source checkout is dirty')
    require(sha(Path(r['dockerfile']).read_bytes()) == r['dockerfileSha256'], 'Dockerfile changed')
    return config, r, head


def image_by_tag(r, tag):
    result = aws('ecr', 'batch-get-image', '--registry-id', ACCOUNT, '--repository-name', r['ecrRepository'], '--image-ids', 'imageTag=' + tag, '--accepted-media-types', *MANIFEST_TYPES)
    require(set(result).issubset({'images', 'failures'}), 'Unexpected ECR response')
    images, failures = result.get('images', []), result.get('failures', [])
    if not images:
        require(len(failures) == 1 and failures[0].get('failureCode') == 'ImageNotFound' and failures[0].get('imageId') == {'imageTag': tag}, 'ECR tag lookup ambiguous')
        return None
    require(len(images) == 1 and not failures, 'ECR tag lookup ambiguous')
    image = images[0]
    require(image.get('registryId') == ACCOUNT and image.get('repositoryName') == r['ecrRepository'] and image.get('imageId', {}).get('imageTag') == tag, 'ECR image identity differs')
    return image


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Config redirect refused')


def read_config(r, descriptor):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', descriptor.get('digest', '')) and isinstance(descriptor.get('size'), int) and 0 < descriptor['size'] <= 8 * 1024 * 1024, 'Config descriptor malformed')
    response = aws('ecr', 'get-download-url-for-layer', '--registry-id', ACCOUNT, '--repository-name', r['ecrRepository'], '--layer-digest', descriptor['digest'])
    require(response.get('layerDigest') == descriptor['digest'], 'Config layer differs')
    url = response.get('downloadUrl', '')
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname and parsed.hostname.endswith('.amazonaws.com') and not parsed.username and not parsed.password and parsed.port in (None, 443), 'Untrusted config transport')
    # Presigned URL remains memory only; never emit API exceptions, headers or URL.
    try:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=30) as res:
            raw = res.read(8 * 1024 * 1024 + 1)
    except Exception:
        raise ValueError('Config transport failed') from None
    require(len(raw) == descriptor['size'] and 'sha256:' + sha(raw) == descriptor['digest'], 'Config bytes differ')
    return json.loads(raw)


def verify_image(image, config, r, head, metadata, image_config):
    raw = image['imageManifest'].encode()
    digest = 'sha256:' + sha(raw)
    require(image['imageId']['imageDigest'] == digest == metadata.get('containerimage.digest'), 'Build and ECR digest differ')
    manifest = json.loads(raw)
    require(manifest.get('schemaVersion') == 2 and manifest.get('mediaType') in MANIFEST_TYPES and isinstance(manifest.get('layers'), list) and manifest['layers'], 'Single image manifest required')
    require(manifest['config']['digest'] == metadata.get('containerimage.config.digest'), 'Build config differs')
    expected = {'org.opencontainers.image.revision': head, 'org.opencontainers.image.source': 'https://github.com/' + config['repository'], 'io.oxy.source.tree': git('rev-parse', head + '^{tree}'), 'io.oxy.dockerfile.sha256': r['dockerfileSha256']}
    labels = image_config.get('config', {}).get('Labels', {})
    require(image_config.get('architecture') == 'arm64' and image_config.get('os') == 'linux' and all(labels.get(k) == v for k, v in expected.items()), 'Image platform/source differs')
    return {'manifestSha256': digest[7:], 'configSha256': manifest['config']['digest'][7:], 'sourceTreeSha': expected['io.oxy.source.tree'], 'labels': expected, 'layerDigests': [l['digest'] for l in manifest['layers']]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['guard', 'vacancy', 'verify'])
    parser.add_argument('--recipe', required=True)
    args = parser.parse_args()
    config, r, head = source_guard(args.recipe)
    tag = head + r['tagSuffix']
    if args.phase == 'guard':
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('source_tree=' + git('rev-parse', head + '^{tree}') + '\n')
        return
    if args.phase == 'vacancy':
        require(image_by_tag(r, tag) is None, 'Immutable source tag already exists; reconcile previous run before retry')
        return
    image = image_by_tag(r, tag)
    require(image is not None, 'Published image is absent')
    metadata = json.loads(os.environ['BUILD_METADATA'])
    manifest = json.loads(image['imageManifest'])
    facts = verify_image(image, config, r, head, metadata, read_config(r, manifest['config']))
    directory = Path(os.environ['RUNNER_TEMP']) / ('reviewed-image-' + r['name'])
    directory.mkdir(mode=0o700, exist_ok=False)
    receipt = {'kind': 'reviewed-arm-image-publication', 'schemaVersion': 1, 'repository': config['repository'], 'sourceSha': head, 'recipe': r, 'imageUri': REGISTRY + '/' + r['ecrRepository'] + '@sha256:' + facts['manifestSha256'], 'tag': tag, 'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'workflowRef': os.environ['GITHUB_WORKFLOW_REF'], 'dockerfileSha256': r['dockerfileSha256'], **facts}
    for name, value in [('receipt.json', receipt), ('build-metadata.json', metadata)]:
        (directory / name).write_text(json.dumps(value, indent=2) + '\n')
    (directory / 'manifest.json').write_bytes(image['imageManifest'].encode())
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('proof_path=' + str(directory) + '\n')
    print(json.dumps({'verified': True, 'recipe': r['name'], 'imageUri': receipt['imageUri']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print subprocess/HTTP exception contents or a presigned config URL.
        print(json.dumps({'verified': False, 'errorType': type(error).__name__, 'reason': str(error) if isinstance(error, Rejected) else 'Publisher validation failed'}))
        raise SystemExit(1)
