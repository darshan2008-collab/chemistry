# Portainer Deployment Guide

Use this for TrueNAS + Portainer deployments.

## 1) Required paths on TrueNAS

Make sure the project exists at one Linux path, for example:

- /mnt/tank/apps/chemistry

The folder must contain:

- /mnt/tank/apps/chemistry/api/package.json
- /mnt/tank/apps/chemistry/api/server.js
- /mnt/tank/apps/chemistry/api/Dockerfile
- /mnt/tank/apps/chemistry/nginx/default.conf
- /mnt/tank/apps/chemistry/students-db.js

## 2) Stack environment variables

Set these in Portainer stack variables:

- PROJECT_ROOT=/mnt/tank/apps/chemistry
- APP_PORT=10004
- APP_ENV=production
- TZ=Asia/Kolkata
- API_PORT=3000
- RETENTION_DAYS=90
- CLEANUP_SCHEDULE=30 2 * * *
- DB_HOST=<external-db-host-or-ip>
- DB_PORT=5432
- DB_NAME=<db-name>
- DB_USER=<db-user>
- DB_PASSWORD=<db-password>
- RESYNC_TOKEN=<long-random-token>
- STACK_NETWORK=chemistry-stack-net

Do not use Windows paths like c:/Users/... for PROJECT_ROOT.

## 3) Redeploy cleanly

After changing variables, recreate containers:

1. Update stack in Portainer with recreate option.
2. If needed, remove old containers and redeploy stack.
3. Ensure Build image is enabled for stack update so chemtest-api is rebuilt.

## 4) Quick verification

Run these on the Docker host:

```sh
docker inspect chemtest-api --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
docker exec -it chemtest-api sh -lc 'ls -la /app; ls -la /app/package.json; ls -la /app/server.js'
docker logs --tail 100 chemtest-api
```

Expected result:

- /app/package.json exists inside chemtest-api container.
- API starts without npm ENOENT.

