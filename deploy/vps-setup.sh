#!/usr/bin/env bash
# ClawBot 服务端 · VPS 部署脚本（在 VPS 宿主机执行）
#
# 用法：
#   SSH_PUBKEY="ssh-ed25519 AAAA... you@machine" bash vps-setup.sh
#
# 可选环境变量：
#   REPO_URL   本仓库的 git 地址（必填，无默认值）
#   BRANCH     默认 main
#   APP_DIR    默认 /opt/clawbot
#   SSH_BIND   默认 127.0.0.1（改 0.0.0.0 才对外；务必用防火墙限定来源 IP）
#   SSH_PORT   默认 2222
#   LOGIN_PORT 默认 8080
#   DEV        默认 1：挂载源码 + 热重载（便于在线改代码验证）；0=用镜像内代码
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/clawbot}"

# ---------------------------------------------------------------------------
# 0) 载入上次部署参数（存在数据卷里，重建容器不会丢）
#
# 为何需要：参数只能靠每次命令行手传，一忘就出事——最常见的翻车是忘了
# `SSH_BIND=0.0.0.0`，容器 SSH 被绑到宿主回环，**公网直接连不上**，
# 而脚本本身不报任何错。这里把上次生效的参数记下来，下次自动沿用；
# 命令行显式传入的值优先级最高。
#
# 只持久化非敏感项：公钥走 <data>/ssh/authorized_keys，不写入本文件。
# ---------------------------------------------------------------------------
CFG_FILE="$APP_DIR/server/data/deploy.env"
if [ -f "$CFG_FILE" ]; then
  while IFS='=' read -r k v; do
    k="$(printf '%s' "$k" | tr -d '[:space:]')"
    case "$k" in
      BRANCH|SSH_BIND|SSH_PORT|LOGIN_PORT|DEV|REPO_URL) ;;
      *) continue ;;
    esac
    # 仅填充「尚未由命令行/环境显式提供」的项
    if eval "[ -z \"\${$k:-}\" ]"; then
      export "$k=$v"
    fi
  done < "$CFG_FILE"
  echo "==> 0/5 已载入上次部署参数：$CFG_FILE"
fi

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
SSH_PUBKEY="${SSH_PUBKEY:-}"
SSH_BIND="${SSH_BIND:-127.0.0.1}"
SSH_PORT="${SSH_PORT:-2222}"
LOGIN_PORT="${LOGIN_PORT:-8080}"
DEV="${DEV:-1}"

if [ -z "$REPO_URL" ]; then
  echo "错误：必须指定 REPO_URL（本仓库的 git 地址），例如：" >&2
  echo "  REPO_URL=https://example.com/you/clawbot.git bash vps-setup.sh" >&2
  exit 1
fi

echo "==> 1/5 准备代码（$BRANCH）"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/server"
mkdir -p data

# 公钥文件：放在宿主 data 目录（= 容器内 /app/data，属于数据卷）
# 这样 docker rm -f + docker run 重建容器后公钥**不会丢**，无需反复注入。
KEY_DIR="$APP_DIR/server/data/ssh"
KEY_FILE="$KEY_DIR/authorized_keys"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
touch "$KEY_FILE"
chmod 600 "$KEY_FILE"
if [ -n "$SSH_PUBKEY" ]; then
  printf '%s\n' "$SSH_PUBKEY" >> "$KEY_FILE"
fi
tr -d '\r' < "$KEY_FILE" | sed '/^[[:space:]]*$/d' | sort -u > "$KEY_FILE.tmp"
mv "$KEY_FILE.tmp" "$KEY_FILE"
chmod 600 "$KEY_FILE"
SSH_PUBKEY="$(cat "$KEY_FILE")"
if [ -z "$SSH_PUBKEY" ]; then
  echo "错误：公钥文件 $KEY_FILE 为空，且未通过 SSH_PUBKEY 传入公钥。" >&2
  echo "      首次部署：SSH_PUBKEY=\"ssh-ed25519 AAAA... you@host\" bash $0" >&2
  exit 1
fi
echo "==> 1.5/5 公钥文件：$KEY_FILE（$(wc -l < "$KEY_FILE") 条，容器重建不会丢）"

echo "==> 2/5 构建镜像"
docker build -t clawbot:dev .

echo "==> 3/5 启动容器"
if [ "$SSH_BIND" = "127.0.0.1" ]; then
  echo "    注意：SSH_BIND=127.0.0.1 → 容器 SSH 只绑宿主回环，公网连不上（需从宿主或 SSH 隧道进）。" >&2
  echo "          要保留公网直连，请用：SSH_BIND=0.0.0.0 bash $0" >&2
fi
# 镜像已在 2/5 构建完成，这里才删旧容器：
# 构建失败时旧容器保持运行，不会出现「旧容器已删、新容器起不来」的服务空窗
docker rm -f clawbot >/dev/null 2>&1 || true

RUN_ARGS=(
  -d --name clawbot
  --restart unless-stopped
  -p "${SSH_BIND}:${SSH_PORT}:22"
  -p "127.0.0.1:${LOGIN_PORT}:8080"
  -v "$APP_DIR/server/data:/app/data"
  -e TZ=Asia/Shanghai
  -e DATA_DIR=/app/data
  -e LOG_LEVEL=info
  -e LOGIN_PAGE_ENABLED=1
  -e LOGIN_PAGE_HOST=127.0.0.1
  -e LOGIN_PAGE_PORT=8080
  -e "SSH_AUTHORIZED_KEYS=${SSH_PUBKEY}"
)
CMD=()

if [ "$DEV" = "1" ]; then
  echo "    DEV=1：挂载源码 + node --watch 热重载"
  RUN_ARGS+=(-v "$APP_DIR/src:/app/src")
  RUN_ARGS+=(-v "$APP_DIR:/repo")
  CMD=(node --watch src/index.js)
  # 若宿主已保存 git 凭据，则只读挂载进容器，便于容器内直接 git pull 更新代码
  for f in /root/.gitconfig /root/.git-credentials; do
    if [ -f "$f" ]; then
      RUN_ARGS+=(-v "$f:$f:ro")
      echo "    已挂载 $f（容器内可 git pull）"
    fi
  done
fi

docker run "${RUN_ARGS[@]}" clawbot:dev "${CMD[@]}"

echo "==> 4/5 容器状态"
sleep 2
if ! docker ps --filter name=clawbot --filter status=running -q | grep -q .; then
  echo "错误：容器没起来（服务当前处于停摆状态），最后 40 行日志如下：" >&2
  docker logs --tail 40 clawbot 2>&1 || true
  exit 1
fi
docker ps --filter name=clawbot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker exec clawbot tail -4 /app/data/server.log 2>/dev/null || true

# 记录本次生效参数，供下次部署沿用（防的正是「忘传 SSH_BIND」这类事故）
{
  echo "# 由 vps-setup.sh 自动生成：上次部署参数。改这里等于改下次的默认值。"
  echo "BRANCH=$BRANCH"
  echo "SSH_BIND=$SSH_BIND"
  echo "SSH_PORT=$SSH_PORT"
  echo "LOGIN_PORT=$LOGIN_PORT"
  echo "DEV=$DEV"
} > "$CFG_FILE"
echo "==> 已记住本次参数：$CFG_FILE"

echo "==> 5/5 完成"
cat <<EOF

容器名：clawbot
  查看二维码/日志： docker logs -f clawbot
  进入容器：        ssh -p ${SSH_PORT} root@${SSH_BIND}
  SSH_BIND 若不是 127.0.0.1，请用安全组/防火墙把 ${SSH_PORT} 限定到可信来源 IP

登录页（扫码）：
  ssh -L ${LOGIN_PORT}:127.0.0.1:${LOGIN_PORT} root@<VPS>   # 建隧道后浏览器打开 http://127.0.0.1:${LOGIN_PORT}

SSH 公钥（重建容器不会丢）：
  ${KEY_FILE}
  增删公钥直接改这个文件，或下次跑本脚本时传 SSH_PUBKEY（会自动追加），然后重建容器即可。

代码位置（DEV=1 时容器内 /app/src 即宿主机 $APP_DIR/src，改完自动重载）：
  $APP_DIR/src   ← 容器内 /app/src
  $APP_DIR              ← 容器内 /repo（可用 git 提交）

EOF
