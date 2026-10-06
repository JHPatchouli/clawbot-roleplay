#!/bin/sh
# 安装「委托用的 agent 框架」（一次性，之后持久保留）。
#
# 为什么要单独一个目录而不是装进 /repo/server/node_modules：
#   ① /repo 是 git 仓库，264MB 的依赖不该进仓库、也不该影响主服务的依赖树；
#   ② 这个目录要能被降权后的 nobody **读**（默认 755/644 正好），
#      而主服务的 data/ 要 700 只给 root —— 两者隔离。
#
# 用法：sh tools/install-delegate-agent.sh [安装目录]   默认 /app/data-agent
set -e
DIR="${1:-/app/data-agent}"
NODEBIN="$(command -v node)"
echo "安装目录：$DIR"
echo "node：$NODEBIN $(node -v)"
mkdir -p "$DIR/work" "$DIR/home"
cd "$DIR"
[ -f package.json ] || npm init -y >/dev/null 2>&1

echo "=== 安装框架 ==="
npm i --no-audit --no-fund @anthropic-ai/claude-agent-sdk@0.3.272

echo "=== 目录权限（nobody 要能读框架、要能写工作目录） ==="
chmod 755 "$DIR"
chmod -R a+rX "$DIR/node_modules"
chown -R 65534:65534 "$DIR/work" "$DIR/home"
chmod 755 "$DIR/work" "$DIR/home"

echo "=== 自检：以 nobody 身份能否读到框架入口 ==="
su -s /bin/sh nobody -c "test -r $DIR/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs && echo 'OK 框架可读' || echo 'FAIL 框架不可读'"

echo "=== 体积 ==="
du -sh "$DIR" 2>/dev/null
echo "DONE"
