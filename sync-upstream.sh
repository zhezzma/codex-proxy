#!/usr/bin/env bash
set -euo pipefail

# 将本地 master 线性重放到 upstream/master 之上，再强制安全推送回 origin。
#
# 用法：
#   ./sync-upstream.sh
#
# 可选环境变量：
#   SKIP_PUSH=1        只 fetch + rebase，不执行 push
#   GITHUB_TOKEN=...   仅当本机没有已保存的 Git HTTPS 凭证时，
#                      才使用一次性 token URL 推送。
#                      优先复用 ~/.git-credentials 或其他 credential helper。
#
# 环境说明：
#   某些 agent / CI 环境不会自动设置 HOME，导致 Git 看不到
#   /root/.gitconfig 与 /root/.git-credentials。
#   这里默认补成 /root，优先复用本机已存凭证，避免每次手输 token。

if [[ -z "${HOME:-}" ]]; then
  export HOME=/root
fi

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

git rev-parse --is-inside-work-tree >/dev/null

branch="$(git branch --show-current)"
if [[ "$branch" != "master" ]]; then
  echo "[sync] 仅支持在 master 分支执行，当前分支：${branch}" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[sync] 工作区不干净，请先提交或 stash 再同步。" >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "[sync] 缺少 upstream 远程。" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[sync] 缺少 origin 远程。" >&2
  exit 1
fi

echo "[sync] 获取 upstream 最新引用..."
git fetch upstream --tags --prune

echo "[sync] 获取 origin 的租约基线..."
git fetch origin --prune "+refs/heads/${branch}:refs/remotes/origin/${branch}"

# 记录本次 rebase 前的起点，用来打印“这次上游新增了哪些 commit”。
old_head="$(git rev-parse HEAD)"
new_base="$(git rev-parse upstream/master)"
merge_base="$(git merge-base "$old_head" "$new_base")"

echo "[sync] 本次上游新增 commits："
if [[ "$merge_base" == "$new_base" ]]; then
  echo "[sync]   无，上游没有比当前分支更新的提交。"
else
  git log --oneline --decorate "$merge_base..$new_base" | sed 's/^/[sync]   /'
fi

echo "[sync] 将 ${branch} rebase 到 upstream/master..."
git rebase upstream/master

if [[ "${SKIP_PUSH:-0}" == "1" ]]; then
  echo "[sync] SKIP_PUSH=1，已跳过 push。"
  exit 0
fi

origin_url="$(git remote get-url origin)"
origin_lease_ref="refs/remotes/origin/${branch}"
origin_lease_oid="$(git rev-parse "$origin_lease_ref")"
lease_arg="--force-with-lease=refs/heads/${branch}:${origin_lease_oid}"

echo "[sync] 当前 HOME=${HOME}"
echo "[sync] 优先尝试复用本机已保存的 Git 凭证推送到 origin/${branch}..."
if git push "$lease_arg" origin "HEAD:${branch}"; then
  exit 0
fi

if [[ -n "${GITHUB_TOKEN:-}" && "$origin_url" == https://* ]]; then
  push_url="${origin_url/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
  echo "[sync] 本机凭证不可用，回退到一次性 token URL 推送..."
  git push "$lease_arg" "$push_url" "HEAD:${branch}"
else
  echo "[sync] 推送失败：本机 Git 凭证不可用，且未提供 GITHUB_TOKEN。" >&2
  exit 1
fi
