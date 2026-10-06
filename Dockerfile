# ClawBot 服务端
# 选 bookworm(glibc) 兼容性好；如需更小体积可换 alpine（注意原生依赖）
FROM node:20-bookworm-slim

# openssh-server：提供容器内 SSH 权限；tini：正确处理信号
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server tini ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global --add safe.directory '*' \
  && mkdir -p /run/sshd

WORKDIR /app

# 先装依赖，利用构建缓存
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    LOGIN_PAGE_PORT=8080 \
    LANG=C.UTF-8

# 22=容器内 SSH；8080=扫码登录页
EXPOSE 22 8080
VOLUME ["/app/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
