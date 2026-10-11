#!/bin/sh
# The entry point for this verifier: runs its checks through the shared runner,
# which keeps the project's verdict contract — 0 holds, 1 fails, 3 could not be
# judged. A check that could not judge its claim must never read as a pass.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/../../_tools_/verify-runner/run.mjs" "$here/check.mjs" "$@"
