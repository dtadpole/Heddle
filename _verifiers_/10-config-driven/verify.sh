#!/bin/sh
# The entry point for this verifier: runs its check through the shared runner,
# which keeps the project's verdict contract — 0 holds, 1 fails, 3 could not be
# judged. A check that could not judge its claim must never read as a pass.
#
#   ./verify.sh            every check, with the verdict
#   ./verify.sh --list     the check names, with what was unjudged and why
#   ./verify.sh --json     one parseable object
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/../../_tools_/runner/run.mjs" "$here/check.mjs" "$@"
