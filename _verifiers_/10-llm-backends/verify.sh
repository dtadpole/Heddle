#!/bin/sh
# The entry point for this verifier: runs its checks through the shared runner,
# which keeps the project's verdict contract — 0 holds, 1 fails, 3 could not be
# judged. A check that could not judge its claim must never read as a pass.
#
#   ./verify.sh            every check, with the verdict
#   ./verify.sh --list     the check names, with what was unjudged and why
#   ./verify.sh --json     one parseable object
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$here/check.mjs" ]; then
  exec node "$here/../../_tools_/verify-runner/run.mjs" "$here/check.mjs" "$@"
fi
# A part with more than one check file runs each and keeps the worst verdict:
# 1 beats 3 beats 0, because a failure outranks an unjudged claim.
status=0
for check in "$here"/check-*.mjs; do
  node "$here/../../_tools_/verify-runner/run.mjs" "$check" "$@" || {
    code=$?
    if [ "$code" -eq 1 ] || [ "$status" -eq 0 ]; then status=$code; fi
  }
done
exit "$status"
