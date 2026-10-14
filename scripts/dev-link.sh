#!/usr/bin/env bash
# Link the installed DeepSeek Harness peer package into this checkout so
# `npm test` can exercise the real base class.
#
# Not needed to install the plugin into a profile: the profile already provides
# the peer, and Node resolves it from the profile's own node_modules.
#
# Usage: scripts/dev-link.sh [directory-containing-dsh-compaction-basic]
#   DSH_PACKAGE_DIR  same, via environment
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve symlinks without relying on GNU readlink -f (absent on macOS).
resolve() {
	local target="$1" dir
	while [ -L "$target" ]; do
		dir="$(cd "$(dirname "$target")" && pwd)"
		target="$(readlink "$target")"
		case "$target" in
		/*) ;;
		*) target="$dir/$target" ;;
		esac
	done
	printf '%s\n' "$target"
}

has_peer() { [ -d "$1/dsh-compaction-basic" ]; }

package_dir="${1:-${DSH_PACKAGE_DIR:-}}"

if [ -z "$package_dir" ]; then
	dsh_bin="$(command -v dsh || true)"
	if [ -z "$dsh_bin" ]; then
		echo "dev-link: cannot find 'dsh' on PATH; pass the directory containing the peer instead" >&2
		exit 1
	fi
	# <...>/@deepseek-ai/dsh/lib/bin.js -> <...>/@deepseek-ai/dsh
	dsh_pkg="$(cd "$(dirname "$(resolve "$dsh_bin")")/.." && pwd)"
	for candidate in "$dsh_pkg/node_modules/@deepseek-ai" "$(dirname "$dsh_pkg")"; do
		if has_peer "$candidate"; then
			package_dir="$candidate"
			break
		fi
	done
fi

if [ -z "$package_dir" ] || ! has_peer "$package_dir"; then
	echo "dev-link: no dsh-compaction-basic under '${package_dir:-<unresolved>}'" >&2
	echo "dev-link: pass the directory that contains the peer package" >&2
	exit 1
fi

peer="$(cd "$package_dir" && pwd)/dsh-compaction-basic"
mkdir -p "$here/node_modules/@deepseek-ai"
ln -sfn "$peer" "$here/node_modules/@deepseek-ai/dsh-compaction-basic"
echo "dev-link: linked $peer"
echo "dev-link: run 'npm test' to exercise the real engine"
