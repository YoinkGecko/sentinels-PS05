# COSMEON FS-LITE

**Orbital Distributed File System Simulation**

> A lightweight, Docker‑based distributed file system where each storage node represents a satellite in orbit. Nodes experience periodic communication blackouts, and the master proactively manages metadata, replication, and availability.

---

## Project Overview

COSMEON FS‑LITE is an educational simulation of an orbital distributed file system. Its goal is to mimic the challenges of storing and retrieving data across satellites that periodically go out of contact due to orbital mechanics. The system demonstrates:

- resilient file storage with multiple replicas,
- leader coordination, heartbeat monitoring, and failure recovery,
- intelligent predictive caching to mitigate upcoming blackouts,
- containerized reproducibility using Docker Compose.

This repository contains all code, configuration, and documentation required to run the simulation locally.

## Problem Overview

Real-world satellite constellations suffer from predictable communication blackouts as each satellite orbits the Earth. Rather than reacting to lost connectivity, COSMEON FS‑LITE simulates this environment and **proactively prepares** for outages by reconstructing and caching files before a node becomes unreachable. The system ensures:

1. Reliable storage across unreliable nodes.
2. Dual replication of every chunk.
3. Seamless recovery when a node fails or enters blackout.

---

## Core Architecture

The system comprises the following components:

- **Master Node** – orchestrates the cluster, handles client requests, stores metadata in Redis, performs leader election, and triggers predictive caching.
- **Three Orbital Storage Nodes** – simulate satellites; store chunks under `node/storage-400*` and periodically enter simulated blackouts (no network access).
- **Redis** – lightweight key‑value store used for metadata, heartbeat records, and availability caching.
- **Docker Compose** – containerizes each service, isolates networking, and enables one‑command deployment.

All services communicate over an internal Docker network; the master exposes a web UI/API on port `3000`, while nodes listen on `4001‒4003`.

---

## Key Features

- **File Chunking & Distribution** – files are split into 1 MB chunks and distributed across the nodes.
- **Dual Replication** – every chunk has a primary and a replica on distinct nodes.
- **Metadata in Redis** – fast lookups for chunk locations, replication status, and node health.
- **Leader Election** – master uses a simple Redis lock to ensure a single active coordinator.
- **Heartbeat Monitoring** – nodes send regular heartbeats; missing heartbeats mark nodes as down.
- **Failure Rebalancing** – when replication drops below two, the master rebalances chunks to maintain redundancy.
- **Predictive Availability Caching** – the master forecasts upcoming blackouts and reconstructs affected files before the node goes offline.
- **Safe Reconstruction Logic** – avoids using soon‑to‑blackout nodes for rebuilds.
- **LRU In‑Memory Cache** – 200 MB bounded cache to speed up reads.
- **Large‑file Support** – tested with files ≥ 49 MB without issues.
- **Docker‑compose One‑command Deployment** – entire stack boots with `docker compose up --build`.

---

## Predictive Availability Caching (WOW Factor)

Unlike traditional systems that **react** to node failures, COSMEON FS‑LITE **predicts** them. Each node broadcasts its blackout schedule; the master uses this information to:

1. Identify chunks that will lose one replica.
2. Reconstruct full files using remaining replicas.
3. Cache reconstructed data locally before the blackout begins.

This results in dramatically lower latency when accessing files during outages and showcases forward‑thinking availability optimization.

---

## Differentiators

- **Orbital blackout model** – connectivity depends on a time‑based schedule rather than random failures.
- **Proactive caching** – prepare for outages instead of reacting to them.
- **Clear Docker separation** – master, nodes, and Redis are distinct containers on an internal network.
- **Failure testing via container kill/restart** – easy to simulate and verify recovery logic.
- **Large‑file chunked storage demo** – shows system scaling to realistic datasets.

---

## Deployment & Installation

### Prerequisites

- Docker & Docker Compose (v2) installed.
- Ports `3000`, `4001`, `4002`, `4003`, and `6379` free (or adjust in `docker-compose.yml`).
- Repo layout:

```
fs-lite/
  master/
  node/
  deploy/
```

### Quick Start

From the `deploy/` directory, run:

```bash
# build and start all services in detached mode
cd fs-lite/deploy
docker compose up -d --build
```

Alternatively, clone and launch in one line:

```bash
git clone <repo-url> && cd <repo>/fs-lite/deploy && docker compose up -d --build
```

The UI/API is available at http://localhost:3000 once the master is up.

### Manual (non‑Docker) Runs

For development without containers:

```bash
# start Redis separately, then:
cd master && npm install
REDIS_URL=redis://127.0.0.1:6379 node server.js 3000

# in another shell:
cd ../node && npm install
REDIS_URL=redis://127.0.0.1:6379 node server.js 4001
# repeat for 4002/4003
```

> ⚠️his approach requires Node.js and Redis installed on your host.

### Customization

- **Change ports**: edit `deploy/docker-compose.yml` under `ports`.
- **External Redis**: remove the internal `redis` service and set `REDIS_URL` in each container.
- **Add/remove nodes**: duplicate or delete `nodeX` blocks in `docker-compose.yml` and update `master/server.js`'s `NODES` array.
- **Use named volumes**: switch the host path mounts to Docker volumes for cleaner storage.

### Stopping & Cleanup

```bash
docker compose down
# to wipe volumes:
docker compose down --volumes --remove-orphans
```

---

## Demonstration Scenario

1. Upload a large file via the master UI/API (`/upload`).
2. Watch chunks appear under `node/storage-4001`, `4002`, `4003`.
3. Wait for the simulated blackout log entries.
4. Observe predictive caching messages in the master logs.
5. Simulate a failure by killing one node container (`docker kill fs-lite_node2_1`).
6. Confirm rebalancing logic recreates missing replicas.
7. Restart the container and verify it rejoins with no data loss.

---

## System Impact

COSMEON FS‑LITE showcases core distributed systems concepts and production‑style engineering:

- replication strategies and metadata coordination,
- failure tolerance and self‑healing behaviors,
- forward‑looking availability optimizations,
- reproducible infrastructure via containers,
- handling large data gracefully.

This project goes beyond a simple proof‑of‑concept and serves as a teaching tool for real‑world design patterns.

---

## Repository Structure

```
fs-lite/
  master/        # master service code and frontend
  node/          # storage node implementation
  deploy/        # docker-compose configuration for full system
  shared/        # common utilities (if any)
  README.md      # (this file) documentation and instructions
```

---

## License

[MIT](LICENSE)

---

Feel free to explore the code, run experiments, and extend the simulator with additional satellite behaviors or caching strategies. Happy hacking! 🚀
