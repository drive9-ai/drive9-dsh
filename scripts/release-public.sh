#!/usr/bin/env bash

set -euo pipefail

mode="${1:---check}"
registry="https://registry.npmjs.org/"

if [[ "$mode" != "--check" && "$mode" != "--publish" ]]; then
  echo "usage: $0 [--check|--publish]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "release refused: git worktree is not clean" >&2
  exit 1
fi

package_name="$(node -p "require('./package.json').name")"
package_version="$(node -p "require('./package.json').version")"
package_license="$(node -p "require('./package.json').license || ''")"
package_ref="${package_name}@${package_version}"

if [[ "$package_name" != "@drive9/drive9-dsh" ]]; then
  echo "release refused: unexpected package name $package_name" >&2
  exit 1
fi

if [[ -z "$package_license" || ! -f LICENSE ]]; then
  echo "release refused: package.json license and LICENSE are required" >&2
  exit 1
fi

if [[ "$mode" == "--publish" ]]; then
  if ! npm whoami --registry "$registry" >/dev/null 2>&1; then
    echo "release refused: run npm login for $registry first" >&2
    exit 1
  fi
  if ! npm org ls drive9 --json --registry "$registry" >/dev/null 2>&1; then
    echo "release refused: the npm user is not a member of the drive9 organization" >&2
    exit 1
  fi
fi

echo "Validating $package_ref from commit $(git rev-parse HEAD)"

npm ci
npm run check
npm test
npm run test:race
npm run build
npm run lint:package
npm publish --dry-run --access public --registry "$registry"
npm audit --omit=dev

if [[ "$mode" == "--check" ]]; then
  echo "$package_ref is ready for a public npm publish"
  exit 0
fi

set +e
view_output="$(npm view "$package_ref" version --json --registry "$registry" 2>&1)"
view_status=$?
set -e
if [[ "$view_status" -eq 0 ]]; then
  echo "release refused: $package_ref already exists on npm" >&2
  exit 1
fi
if [[ "$view_output" != *"E404"* ]]; then
  echo "release refused: could not prove $package_ref is absent from npm" >&2
  echo "$view_output" >&2
  exit 1
fi

printf 'Publish %s to %s? [y/N] ' "$package_ref" "$registry"
read -r answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "publish cancelled"
  exit 1
fi

npm publish --access public --registry "$registry"
