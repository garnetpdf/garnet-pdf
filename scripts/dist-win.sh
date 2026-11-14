#!/usr/bin/env bash
set -euo pipefail
npm run notices
npm run build
image='electronuserland/builder@sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe'
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker pull "$image"
fi
mkdir -p .builder-cache
image_digest="$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')"
exec docker run --rm --cpus=2 --memory=4g --env ELECTRON_CACHE=/project/.builder-cache/electron --env ELECTRON_BUILDER_CACHE=/project/.builder-cache/builder -v "$PWD:/project" -w /project "$image_digest" /bin/bash -lc 'npx electron-builder --win nsis zip --x64'
