#!/usr/bin/env bash

# Add tags to an image already in ECR, by digest: a re-tag, nothing is pushed.
#
#   tag-ecr-image.sh <repository> <sha256:digest> <tag>...
#
# The release step tags the image it is about to roll out `deployed-<sha>`
# (plus the commit tag, and `latest` where a repository still moves it). The
# ECR lifecycle policy keeps the last ten `deployed-*` images for rollback
# (oxy-infra terraform-uswest2/ecr.tf).
#
# The manifest is read back from ECR and written with --image-digest, so ECR
# itself refuses the write unless the bytes still hash to the digest given: a
# tag can only ever land on exactly that image. Re-tagging with a tag the image
# already has is not an error.

set -euo pipefail

repository="${1:?usage: tag-ecr-image.sh <repository> <digest> <tag>...}"
digest="${2:?usage: tag-ecr-image.sh <repository> <digest> <tag>...}"
shift 2
if [[ $# -eq 0 ]]; then
  echo "::error::tag-ecr-image.sh: no tags given" >&2
  exit 2
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::tag-ecr-image.sh: not a sha256 digest: $digest" >&2
  exit 2
fi

image="$(aws ecr batch-get-image \
  --repository-name "$repository" \
  --image-ids "imageDigest=$digest" \
  --accepted-media-types \
  application/vnd.oci.image.index.v1+json \
  application/vnd.docker.distribution.manifest.list.v2+json \
  application/vnd.oci.image.manifest.v1+json \
  application/vnd.docker.distribution.manifest.v2+json \
  --output json)"
manifest="$(jq -r '.images[0].imageManifest // empty' <<<"$image")"
media_type="$(jq -r '.images[0].imageManifestMediaType // empty' <<<"$image")"
if [[ -z "$manifest" || -z "$media_type" ]]; then
  echo "::error::$repository@$digest is not in ECR; nothing tagged." >&2
  exit 1
fi

for tag in "$@"; do
  if output="$(aws ecr put-image \
    --repository-name "$repository" \
    --image-manifest "$manifest" \
    --image-manifest-media-type "$media_type" \
    --image-digest "$digest" \
    --image-tag "$tag" \
    --output json 2>&1)"; then
    echo "Tagged $repository@$digest as $tag"
  elif grep -q 'ImageAlreadyExistsException' <<<"$output"; then
    echo "$repository@$digest is already $tag"
  else
    echo "::error::Could not tag $repository@$digest as $tag: $output" >&2
    exit 1
  fi
done
