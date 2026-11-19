#!/usr/bin/env bash
# After a PR merges: lists the local branches and worktrees it left behind,
# and with --apply removes them. A branch qualifies only when its upstream
# is gone (deleted on GitHub: by hand until the repository deletes head
# branches on merge, decision 0001) AND it is merged
# into origin/main. "Merged" alone isn't enough: a new branch with no
# commits yet counts as merged too, and one never pushed has no upstream,
# so neither is touched.
#
# Merged means either of:
# - an ancestor of origin/main (PRs merged with a merge commit, up to #6);
# - its tip is, or is an ancestor of, the head of a PR GitHub merged into
#   main from a branch of that name (`gh pr list --state merged`). A squash merge, how
#   PRs merge now, leaves no ancestry to check, so GitHub is asked instead:
#   every local commit reached the merged PR. A commit added locally after
#   the merge, or no `gh`, keeps the branch.
#
# Deletes only safely: `git worktree remove` without --force (refuses
# uncommitted or untracked files; ignored ones like node_modules, dist and
# .logs go with the worktree) and `git branch -D` only after the check
# above has proved the branch was merged. Plain -d would compare
# against HEAD instead (the upstream is gone), so a main checkout that
# hasn't been pulled yet made it refuse branches that were already merged.
# Never touches main, the main checkout, the worktree the script lives in,
# or the one it is called from (removing a session's own worktree strands
# it); to clean up the current one, run scripts/new-worktree.sh and rerun
# from there. A branch some worktree still has checked out is kept too.
#
# Usage: scripts/cleanup-merged.sh [--apply]   (default: dry run)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
# The checkout this was called from, which may not be the script's own
# (another worktree calling the main checkout's copy, say).
caller="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "$root")" && pwd -P)"
cd "$root"
apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

git fetch -q --prune origin
# The first entry of `git worktree list` is always the main checkout.
main_checkout="$(git worktree list --porcelain | head -n 1 | sed 's/^worktree //')"

# The branch's commits all reached a PR GitHub merged into main (see the
# header). Without an answer from gh, says so once and keeps the branch.
gh_noted=0
squash_merged() {
  local heads head
  if ! heads="$(gh pr list --state merged --base main --head "$1" \
    --json headRefOid --jq '.[].headRefOid' 2>/dev/null)"; then
    ((gh_noted)) || echo "note: gh unavailable; squash-merged branches are kept" >&2
    gh_noted=1
    return 1
  fi
  for head in $heads; do
    # Fails when the head commit isn't here, which keeps the branch.
    git merge-base --is-ancestor "refs/heads/$1" "$head" 2>/dev/null && return 0
  done
  return 1
}

finished() {
  [[ "$1" != "main" ]] \
    && [[ "$(git for-each-ref --format='%(upstream:track)' "refs/heads/$1")" == "[gone]" ]] \
    && { git merge-base --is-ancestor "refs/heads/$1" origin/main || squash_merged "$1"; }
}

found=0
# A dry run's would-remove worktrees: their branches count as free below.
freed=""

# Worktrees first: a branch can't be deleted while a worktree has it out.
while IFS=$'\t' read -r path branch; do
  [[ "$path" == "$main_checkout" ]] && continue
  finished "$branch" || continue
  found=1
  if [[ "$path" == "$root" || "$path" == "$caller" ]]; then
    echo "skip      worktree $path ($branch): this script runs from it"
  elif ((apply)); then
    git worktree remove "$path" && echo "removed   worktree $path ($branch)"
  else
    echo "would remove worktree $path ($branch)"
    freed+="$branch"$'\n'
  fi
done < <(git worktree list --porcelain \
  | awk '/^worktree /{path=substr($0, 10)} /^branch /{print path "\t" substr($0, 19)}')
git worktree prune

# Branches still checked out (in a skipped or refused worktree, or the main
# checkout): git won't delete them, and trying would stop this run.
checked_out="$(git worktree list --porcelain | sed -n 's#^branch refs/heads/##p' \
  | grep -Fxv -f <(printf '%s' "$freed") || true)"

while read -r branch; do
  finished "$branch" || continue
  found=1
  if grep -Fxq -- "$branch" <<<"$checked_out"; then
    echo "keep      branch $branch: a worktree still has it checked out"
  elif ((apply)); then
    # finished() just checked it was merged; see the header.
    git branch -D -q "$branch" && echo "deleted   branch $branch"
  else
    echo "would delete branch $branch"
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads)

if ((!found)); then
  echo "nothing to clean up"
elif ((!apply)); then
  echo "dry run; rerun with --apply to delete"
fi
