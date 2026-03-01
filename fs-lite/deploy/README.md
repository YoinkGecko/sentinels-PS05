Comprehensive Docker setup for fs-lite

Overview

- **Purpose:** Run the `master` API + three storage `node` instances and Redis using Docker Compose so another developer can start the full system with one command and then open the UI at http://localhost:3000.
- **Location:** This README belongs to the `deploy/` folder and the compose file is `deploy/docker-compose.yml`.

Prerequisites

- **Docker & Docker Compose:** Install Docker Desktop (macOS) or Docker Engine + Docker Compose v2.
- **Port availability:** Make sure ports 3000, 4001, 4002, 4003 and 6379 are free or change the published ports in `docker-compose.yml`.
- **Workspace layout:** This compose file expects the repository layout to include `master/` and `node/` directories next to `deploy/`:

```
fs-lite/
  master/
  node/
  deploy/
```

Quick start (one-liners)

- From the `deploy/` folder, build and start the system in detached mode:

```bash
docker compose up -d --build
```

- Clone the repo and run in one line (replace `<repo-url>`):

```bash
git clone <repo-url> && cd <repo>/fs-lite/deploy && docker compose up -d --build
```

What this starts

- **`redis`**: Redis server (internal network name `redis`, exposed on host 6379).
- **`node1`, `node2`, `node3`**: Three storage node services (exposed on 4001, 4002, 4003). Each node stores chunk files under the mounted `node/storage-400*` folder.
- **`master`**: Master API and frontend (exposed on 3000). The master uses Redis to store metadata and discovery.

Verify

- Check containers are healthy / running:

```bash
docker compose ps
docker compose logs -f master
```

- Open the UI / API in your browser: http://localhost:3000

Customization

- **Change ports**: Edit `deploy/docker-compose.yml` `ports` mapping for each service.
- **Use an external Redis**: Remove the `redis` service in `docker-compose.yml` and set `REDIS_URL` to your Redis URI in the `environment` sections for services. Example: `REDIS_URL=redis://host:6379`.
- **Add or remove storage nodes**: Duplicate or remove `node2`/`node3` blocks in `docker-compose.yml`. Also adjust `master/server.js` NODES array if you change node ports or addresses.
- **Persistent storage**: Compose currently mounts host folders `../node/storage-4001`, etc. If you prefer Docker volumes, switch `volumes:` to named volumes in the compose file.

Troubleshooting

- "Cannot connect to the Docker daemon" — start Docker Desktop and retry.
- "attribute `version` is obsolete" — safe to ignore; you can remove the `version:` line from `docker-compose.yml` if desired.
- If master reports "Provide port" or a service exits, confirm the `command:` in compose supplies the port argument (compose includes them already).
- If nodes cannot connect to Redis, verify `REDIS_URL` is `redis://redis:6379` (this compose sets that by default) and check `docker compose logs redis`.

Stopping and cleanup

```bash
docker compose down
docker compose down --volumes --remove-orphans
```

Advanced: run without Docker

- You can also run services locally without Docker for development. Example (from `master/`):

```bash
cd master
npm install
REDIS_URL=redis://127.0.0.1:6379 node server.js 3000

# and for a node
cd ../node
npm install
REDIS_URL=redis://127.0.0.1:6379 node server.js 4001
```

Security & notes

- This setup is for local development and demonstration only. Do not expose these services to the public internet without adding authentication, TLS, and securing Redis.
- The compose mounts host storage directories for easy inspection; in production use controlled volumes and secure storage.

If something fails

- Run `docker compose logs -f` to follow logs.
- Confirm Docker daemon is running (`docker info`).
- Ensure the repo layout is correct and `node/storage-4001` (etc.) directories exist.

Contact

- If you want, I can add healthchecks, wait-for scripts, or improve the compose to use named volumes and dynamic node counts.
