#!/bin/bash
# 容器入口：注入 SSH 凭据 → 启动 sshd → 前台运行 Node 服务
set -e

mkdir -p /run/sshd /root/.ssh /app/data
chmod 700 /root/.ssh

# 幂等地设置 sshd 配置项：行存在（含被注释）就改写，否则追加。
set_sshd_opt() {
  key="$1"
  val="$2"
  if grep -qiE "^#?[[:space:]]*${key}[[:space:]]" /etc/ssh/sshd_config; then
    sed -i -E "s|^#?[[:space:]]*${key}[[:space:]].*|${key} ${val}|I" /etc/ssh/sshd_config
  else
    printf '%s %s\n' "$key" "$val" >> /etc/ssh/sshd_config
  fi
}

# 1) SSH 授权（公钥）
#
# ⚠️ 为何要落到数据卷：
#   /root/.ssh 在**容器可写层**，而 vps-setup.sh 每次部署都会 docker rm -f + docker run，
#   于是每次重建容器公钥都会丢、都得重新注入。
#   改为以数据卷里的 /app/data/ssh/authorized_keys 为**权威来源**：
#     - 环境变量 SSH_AUTHORIZED_KEYS 只当「首次播种」（追加，不覆盖）
#     - 每次启动把数据卷里的公钥合并去重后装载到 /root/.ssh
#     - 增删公钥：直接编辑宿主机 <APP_DIR>/server/data/ssh/authorized_keys
KEY_DIR=/app/data/ssh
KEY_FILE="$KEY_DIR/authorized_keys"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
touch "$KEY_FILE"
chmod 600 "$KEY_FILE"

if [ -n "$SSH_AUTHORIZED_KEYS" ]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEYS" >> "$KEY_FILE"
  echo "[entrypoint] 已把 SSH_AUTHORIZED_KEYS 并入公钥文件 $KEY_FILE"
fi

# 去 CR（宿主机侧编辑容易引入 CRLF，带 \r 的 key 会被 sshd 静默拒绝）、去空行、去重
tr -d '\r' < "$KEY_FILE" | sed '/^[[:space:]]*$/d' | sort -u > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

if [ -s /root/.ssh/authorized_keys ]; then
  set_sshd_opt PubkeyAuthentication yes
  echo "[entrypoint] 已从数据卷装载 $(wc -l < /root/.ssh/authorized_keys) 条公钥"
else
  echo "[entrypoint] 警告：公钥文件为空（$KEY_FILE），只能靠密码登录"
fi

# 2) root 登录方式：设了密码才开密码登录，否则只认公钥
#
# ⚠️ 为何必须**显式**写成 no：
#   sshd 的 PasswordAuthentication 默认值就是 yes，配置里那行本是注释掉的，
#   所以「不去动它」= 密码登录开着。只有落成 no 才算真关。
#   关闭前先确认公钥文件非空，否则会无法登录。
HAVE_PUBKEY=0
if [ -s /root/.ssh/authorized_keys ]; then
  HAVE_PUBKEY=1
fi

if [ -n "$SSH_ROOT_PASSWORD" ]; then
  echo "root:$SSH_ROOT_PASSWORD" | chpasswd
  set_sshd_opt PermitRootLogin yes
  set_sshd_opt PasswordAuthentication yes
  echo "[entrypoint] 已启用 root 密码登录（设置了 SSH_ROOT_PASSWORD）"
elif [ "$HAVE_PUBKEY" = "1" ]; then
  set_sshd_opt PermitRootLogin prohibit-password
  set_sshd_opt PasswordAuthentication no
  set_sshd_opt KbdInteractiveAuthentication no
  echo "[entrypoint] 未设置 SSH_ROOT_PASSWORD：已关闭密码登录，仅允许公钥"
else
  # 既无公钥也无密码：留着密码登录作兜底（其实也没密码可用），并大声警告
  set_sshd_opt PermitRootLogin yes
  echo "[entrypoint] 警告：公钥文件为空且未设置 SSH_ROOT_PASSWORD，当前无法登录，请先注入公钥再重建" >&2
fi

ssh-keygen -A

# 启动前把生效值打出来：避免「以为关了其实没关」这种静默失效
echo "[entrypoint] sshd 生效：$(/usr/sbin/sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication|kbdinteractiveauthentication) ' | tr '\n' ' ')"
/usr/sbin/sshd -e

echo "[entrypoint] sshd 已启动（容器内 22 端口）"

# 支持覆盖启动命令（如 node --watch src/index.js 用于开发热重载）
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] 使用自定义启动命令：$*"
  exec "$@"
fi
exec node src/index.js
