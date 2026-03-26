# Portainer Deployment Guide

Use this for TrueNAS + Portainer with Git-based stack deployment.

## 1) How this deployment now works

1. App code is built directly from your Git repo by Docker.
2. Student uploads are persisted to host path using `UPLOADS_ROOT`.
3. No host bind mount is used for `/app` code, so `/app/package.json` mount errors are avoided.

## 2) Required repository files

Your Git repo must contain:

- `api/package.json`
- `api/server.js`
- `api/Dockerfile`
- `nginx/default.conf`
- `nginx/Dockerfile`
- frontend `*.html`, `*.css`, `*.js`
- `students-db.js`

## 3) Stack environment variables

Set these in Portainer stack variables:

- `UPLOADS_ROOT=/mnt/tank/apps/chemistry-data/uploads`
- `POSTGRES_ROOT=/mnt/tank/apps/chemistry-data/postgres`
- `APP_PORT=10004`
- `APP_ENV=production`
- `TZ=Asia/Kolkata`
- `API_PORT=3000`
- `RETENTION_DAYS=90`
- `CLEANUP_SCHEDULE=30 2 * * *`
- `DB_HOST=<external-db-host-or-ip>`
- `DB_PORT=5432`
- `DB_NAME=<db-name>`
- `DB_USER=<db-user>`
- `DB_PASSWORD=<db-password>`
- `RESYNC_TOKEN=<long-random-token>`
- `AUTH_PEPPER=<long-random-auth-pepper>`
- `AUTH_SESSION_TTL_HOURS=24`
- `STAFF_DEFAULT_EMAIL=<staff-email>`
- `STAFF_DEFAULT_PASSWORD=<staff-password>`
- `STAFF_DEFAULT_NAME=Chemistry Admin`
- `STAFF_DEFAULT_ROLE=Chemistry Teacher`
- `STACK_NETWORK=chemistry-stack-net`

Create uploads path on host first:

```sh
mkdir -p /mnt/tank/apps/chemistry-data/uploads
mkdir -p /mnt/tank/apps/chemistry-data/postgres
```

## 4) Deploy steps in Portainer

1. Use Stack from Git repository.
2. Enable build/rebuild when updating the stack.
3. Deploy with recreate.

## 5) Optional internal DB mode

`chemtest-db` is under profile `internal-db`.

- External DB (recommended): default deployment, no profile needed.
- Internal DB: deploy with compose profile `internal-db` and set `DB_HOST=chemtest-db`.

## 6) Quick verification

Run these on Docker host:

```sh
docker compose ps
docker logs --tail 100 chemtest-api
docker logs --tail 100 chemtest-web
```

Expected result:

- `chemtest-api` healthy and listening on 3000
- `chemtest-web` healthy
- uploads written to `${UPLOADS_ROOT}`

