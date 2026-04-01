# Full Program Audit: Remedies, Development, and Implementations

Date: 2026-04-01
Project: chemistry

## Executive Summary

The application is feature-rich and operational, but it currently has important security, reliability, and maintainability risks. The highest-priority issues are:

1. Student data exposure on the client.
2. Weak password hashing strategy.
3. In-memory session store (not durable/scalable).
4. Public/static access pattern for uploaded files.
5. Large monolithic backend file and no automated test/CI pipeline.

This document provides practical remedies and a phased implementation plan.

## Architecture Snapshot

- Frontend: Multiple role-specific HTML/CSS/JS pages (student, staff, superadmin, PPT).
- Backend: Node/Express API in a single large file (`api/server.js`).
- Storage: PostgreSQL + file storage under uploads.
- Deployment: Docker Compose stack with web, api, db, cleanup service.

## Findings and Remedies

### 1) Critical: Student directory exposure in frontend

Problem:
- Student master data is accessible client-side and used for login-side validation.

Risks:
- Privacy exposure and easy account enumeration.

Remedy:
1. Remove student master list usage from frontend login flow.
2. Perform validation only in backend login endpoint.
3. Show student identity details only after authenticated session.

Implementation:
- Remove client import/use of `students-db.js` in login pages.
- Keep login payload minimal (`regNo`, `password`) and let backend decide validity.
- Return only required student profile data after successful login.

### 2) Critical: Password hashing is too weak

Problem:
- Fast hash strategy (SHA-256 style flow) is vulnerable to offline cracking.

Risks:
- Compromised hash DB can be cracked quickly.

Remedy:
1. Adopt `argon2id` (preferred) or `bcrypt`.
2. Add migration path for existing users.
3. Enforce password policy and rotation for admin/staff defaults.

Implementation:
- Add `hashPassword()` and `verifyPassword()` using argon2/bcrypt.
- On login:
  1. Verify legacy hash if present.
  2. If valid, rehash with new algorithm and store immediately.
- Remove weak default passwords and force env-based credentials.

### 3) High: In-memory session storage

Problem:
- Sessions are process-local memory only.

Risks:
- All logins drop on restart; no multi-instance support.

Remedy:
1. Move sessions to Redis-backed store.
2. Add rolling expiration + idle timeout.
3. Add session revocation and optional single-session policy.

Implementation:
- Integrate Redis and store session metadata (`userId`, `role`, `exp`, `lastSeen`).
- Add secure cookie or bearer token with server-side session validation.
- Add logout-all endpoint for account security events.

### 4) High: Public static serving of upload directories

Problem:
- Uploads can be directly served from static path patterns.

Risks:
- Unauthorized file access through leaked/guessable URLs.

Remedy:
1. Remove direct static serving for protected uploads.
2. Provide authenticated download endpoint with permission checks.
3. Optionally generate short-lived signed URLs.

Implementation:
- Replace static mappings with `GET /api/files/:id` guarded by auth + ownership/role checks.
- Store metadata (owner, subject, visibility, mime, size, checksum).
- Log all download access attempts.

### 5) High: Duplicate file persistence (disk + DB binary)

Problem:
- Same file content may be stored in both filesystem and DB `bytea`.

Risks:
- DB bloat, slower backup/restore, increased complexity.

Remedy:
1. Keep file bytes in one storage layer only.
2. Keep DB metadata only (recommended).
3. Add migration script to normalize existing records.

Implementation:
- Add migration job:
  1. Move DB blobs to file/object storage.
  2. Update metadata pointers.
  3. Remove blob column usage after verification.

### 6) High: Retention/cleanup mismatch risk

Problem:
- Cleanup process appears age-based and not always DB-coordinated.

Risks:
- Broken references, missing files, orphan records.

Remedy:
1. Make retention DB-driven.
2. Delete metadata and file in coordinated workflow.
3. Add periodic reconciler for orphans.

Implementation:
- Introduce cleanup API/job that selects expired records from DB and removes both DB+file atomically.
- Add weekly audit report for missing file pointers.

### 7) Medium: XSS surface from dynamic `innerHTML`

Problem:
- Several views render user/server data via template strings.

Risks:
- Script injection if any unescaped field reaches templates.

Remedy:
1. Prefer DOM APIs (`createElement`, `textContent`).
2. Centralize safe escaping utility for unavoidable HTML templates.
3. Add CSP and strict response headers.

Implementation:
- Replace high-risk render paths first (messages, uploads, materials lists).
- Add middleware headers:
  - `Content-Security-Policy`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy`

### 8) Medium: Monolithic backend file

Problem:
- Most backend concerns are in one large file.

Risks:
- Hard reviews, brittle changes, regression risk.

Remedy:
1. Modularize by domain.
2. Introduce service/repository boundaries.
3. Centralize validation and error handling.

Implementation:
- Suggested structure:
  - `api/src/routes/*.js`
  - `api/src/services/*.js`
  - `api/src/repositories/*.js`
  - `api/src/middleware/*.js`
  - `api/src/lib/*.js`
- Start with auth and uploads modules first.

### 9) Medium: Secret management hygiene

Problem:
- Risk of tracking runtime secrets if `.env` is not safely ignored and managed.

Risks:
- Credential leakage.

Remedy:
1. Ensure `.env` is gitignored.
2. Keep `.env.example` placeholders only.
3. Rotate exposed credentials immediately.

Implementation:
- Update `.gitignore` and confirm no secrets in git history.
- Rotate staff/admin credentials and token secrets.

### 10) Medium: Missing automated tests and CI

Problem:
- No comprehensive automated regression safety net.

Risks:
- Frequent breakages and slow delivery confidence.

Remedy:
1. Add backend integration tests for auth, role checks, uploads, and subject scoping.
2. Add UI smoke tests for key role flows.
3. Add CI pipeline gates.

Implementation:
- CI stages:
  1. Lint
  2. Unit/integration tests
  3. Docker build validation
  4. Smoke checks

## Development Roadmap (Phased)

### Phase 1 (Week 1): Security Baseline

1. Remove frontend student master data dependency.
2. Enforce env-only admin/staff credentials.
3. Add `.env` hardening and secret rotation.
4. Add login rate limits and lockout policy.

Success criteria:
- No student list delivered to browser.
- No weak default credential fallback in code.

### Phase 2 (Week 2): Auth and Session Hardening

1. Migrate password hashing to argon2/bcrypt.
2. Introduce Redis-backed session store.
3. Add global/session revocation endpoints.

Success criteria:
- Sessions survive restart and support scale.
- Legacy passwords transparently upgraded.

### Phase 3 (Week 3): File Security and Retention

1. Stop direct static serving for protected uploads.
2. Implement authenticated file download endpoint.
3. Normalize storage to metadata-only DB + file/object bytes.
4. DB-driven retention cleanup and orphan reconciler.

Success criteria:
- No unauthorized direct file URL access.
- No storage duplication growth.

### Phase 4 (Week 4): Maintainability + Quality

1. Break backend into modules by domain.
2. Add integration and smoke tests.
3. Add CI pipeline and deployment checks.

Success criteria:
- Reduced regression rate.
- Faster and safer feature development.

## Implementation Details (Concrete Tasks)

### Backend

1. Add package dependencies:
- `argon2` or `bcrypt`
- `ioredis`/`redis`
- `helmet`
- `express-rate-limit`
- test stack (`vitest`/`jest`, `supertest`)

2. New middleware:
- Auth/session verification
- Role/subject access checks
- Input validation
- Error normalizer

3. New modules:
- `auth.service`
- `session.store`
- `uploads.service`
- `materials.service`
- `staff-assignments.service`

4. Migrations:
- Password hash format migration
- Optional file blob normalization migration

### Frontend

1. Replace risky `innerHTML` with safe DOM rendering in sensitive screens first.
2. Standardize API client error handling and token expiry behavior.
3. Add clear role-capability driven UI toggles from backend capabilities response.

### DevOps

1. Add CI workflow with lint/test/build.
2. Add staging smoke test script invocation.
3. Add health/readiness probes and structured logs.

## Priority Matrix

- P0 (Immediate): Student data exposure, password hashing, static upload access, secret fallback removal.
- P1 (Next): Session store migration, retention cleanup correctness.
- P2 (Planned): Backend modularization, XSS hardening refactor, CI expansion.

## Risk if Not Implemented

1. Increased chance of credential compromise and privacy violations.
2. Production instability under restart/scale events.
3. Data/storage growth and costly maintenance operations.
4. Continued regressions due to low automated coverage.

## Recommended First Implementation Sprint (Practical)

1. Remove client-side student list and adjust student login flow.
2. Introduce bcrypt/argon2 with legacy hash migration-on-login.
3. Replace static upload serving with authorized download endpoint.
4. Add `.env` protections and rotate default credentials.
5. Add minimal API integration tests for login/upload/authz.

---

If needed, this report can be converted into a task tracker format with ticket-ready items (owner, estimate, dependencies, acceptance criteria).
