Quick Docker setup for this project

From the `deploy/` folder run:

```bash
docker compose up -d --build
```

This will start:

- `redis` (port 6379)
- three storage nodes (ports 4001,4002,4003)
- the master service (port 3000)

Open http://localhost:3000 in your browser after services are up.

Notes:

- The compose file mounts `../node/storage-4001` etc. Ensure those folders exist or create them.
- If you already have Redis running locally, you can remove the `redis` service and set `REDIS_URL` to your Redis address.
