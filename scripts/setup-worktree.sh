#!/usr/bin/env bash
# Prepares a fresh checkout (usually a git worktree under .claude/worktrees/)
# to run: node_modules from the lockfile (better-sqlite3 builds its native
# module here), and the main checkout's .env, if it has one, so
# `npm run dev` works in the worktree. The tests need neither .env nor a
# database: they run against an in-memory SQLite (test/setup.ts).
# Safe to re-run; an existing .env in the worktree is left alone.
#
# The .env must hold the local-dev bot's token, never production's (see
# the README's warning).
#
# Usage: scripts/setup-worktree.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
# The first entry of `git worktree list` is always the main checkout.
main_checkout="$(git -C "$root" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"

echo "npm ci"
(cd "$root" && npm ci --loglevel=error --no-audit --no-fund)

if [[ "$root" != "$main_checkout" && -f "$main_checkout/.env" && ! -e "$root/.env" ]]; then
  cp "$main_checkout/.env" "$root/.env"
  echo "copied .env from the main checkout"
fi

echo "ready"
