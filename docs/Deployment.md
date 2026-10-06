# Deployment

The service requires Node.js 20 or newer. On the first launch, it starts the ClawBot login flow and stores credentials in `data/`.

## Local

```bash
git clone https://github.com/JHPatchouli/clawbot-roleplay.git
cd clawbot-roleplay
npm install
npm start
```

Runtime data, logs, and credentials are stored in `data/`. The log file is `data/server.log`.

## Docker Compose

Create `.env` in the repository directory and set one container login method:

```bash
SSH_AUTHORIZED_KEYS="ssh-ed25519 AAAA... you@host"
```

`SSH_ROOT_PASSWORD` can be used instead. Then start the service:

```bash
docker compose up -d --build
docker logs -f clawbot
```

The default ports are bound only to `127.0.0.1` on the host:

| Host port | Container port | Purpose |
|---|---|---|
| 2222 | 22 | Container SSH |
| 8080 | 8080 | Login page |

The login page is not exposed directly. Reach it through an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 -p 2222 root@127.0.0.1
```

Open `http://127.0.0.1:8080` after the tunnel is connected.

## VPS

`deploy/vps-setup.sh` clones the repository, builds the image, and starts the container on a VPS. The first run requires the repository URL and an SSH public key:

```bash
REPO_URL="https://github.com/JHPatchouli/clawbot-roleplay.git" \
SSH_PUBKEY="ssh-ed25519 AAAA... you@host" \
bash deploy/vps-setup.sh
```

Common variables:

| Variable | Default | Purpose |
|---|---|---|
| `APP_DIR` | `/opt/clawbot` | Code and data directory |
| `BRANCH` | `main` | Branch to deploy |
| `SSH_BIND` | `127.0.0.1` | Host address for container SSH |
| `SSH_PORT` | `2222` | Host port for container SSH |
| `LOGIN_PORT` | `8080` | Host port for the login page |
| `DEV` | `1` | `1` mounts the source and enables reload; `0` uses the image contents |

With `SSH_BIND=127.0.0.1`, container SSH is reachable only from the VPS itself. Set `SSH_BIND=0.0.0.0` for a public entry point and restrict its source addresses with a firewall. The script stores the effective values in `data/deploy.env` and reuses them on the next run.

After deployment:

```bash
docker logs -f clawbot
ssh -p 2222 root@127.0.0.1
```

Public keys are stored on the host at `data/ssh/authorized_keys`. Add a key there and run the deployment script again to load it into the container.
