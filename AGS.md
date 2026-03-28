# AGS Prompt: Multi-Subject, Multi-Staff, Super Admin Assignment Model

## Objective
Upgrade the ChemTest portal to support:
- Multiple subjects in the system.
- Multiple staff members, each able to handle one or more subjects.
- Super Admin-controlled assignment of students to staff per subject.
- Staff upload of official learning materials per subject.
- Super Admin database operations (backup download, wipe, restore/re-upload) with strong safeguards.
- Live active-user monitoring for Super Admin.
- Admin-only broadcast messages from staff to all students.
- Per-student file storage quota of 500 MB for uploads (ppt, pdf, png, jpg, and similar allowed docs/images/videos).

The implementation must preserve existing student login and submission behavior while adding controlled role-based assignment workflows.

## Roles and Permissions
### Super Admin
- Create, edit, deactivate, and reset passwords for staff.
- Create, edit, and deactivate subjects.
- Assign or unassign students to staff for specific subjects.
- View assignment matrix and audit logs.
- View live active users and session health.
- Download database backup, clear database (guarded flow), and restore database from backup.

### Staff
- Access only assigned students for assigned subjects.
- Create tests, grade submissions, and export reports only within authorized subject scope.
- Upload official materials for their assigned subjects.
- Send admin announcements/messages to all students.
- Cannot create users, subjects, or global assignments.

### Student
- View subject list assigned to them.
- Submit tests only for subjects they are assigned to.
- See own marks and feedback by subject.

## Core Business Rules
1. A student can be assigned to multiple subjects.
2. A subject can have multiple staff members.
3. A staff member can handle multiple subjects.
4. Student-to-staff assignment is subject-specific.
5. If a student is not assigned to a staff member for a subject, that staff member must not see the student for that subject.
6. Super Admin is the only role allowed to manage assignment mappings.
7. Only staff assigned to a subject can upload/edit materials for that subject.
8. Broadcast messages from staff are read-only for students and must be audit logged.
9. Database wipe/restore operations are Super Admin only and require explicit confirmation.
10. Each student has a hard storage quota of 500 MB across all their uploaded files.

## Data Model Requirements
Add/extend tables as below.

### subjects
- id (PK, UUID or bigserial)
- code (unique, not null)
- name (not null)
- is_active (boolean, default true)
- created_at
- updated_at

### staff_accounts (existing, extend if needed)
- ensure role supports values like Super Admin and Staff
- keep is_active and password hash fields

### student_subject_assignments
Map student to subject globally.
- id (PK)
- reg_no (FK -> students.reg_no)
- subject_id (FK -> subjects.id)
- is_active (boolean, default true)
- created_at
- updated_at
- unique(reg_no, subject_id)

### staff_subject_assignments
Map staff to subject.
- id (PK)
- staff_email (FK -> staff_accounts.email)
- subject_id (FK -> subjects.id)
- is_active (boolean, default true)
- created_at
- updated_at
- unique(staff_email, subject_id)

### student_staff_subject_assignments
Exact assignment matrix controlled by Super Admin.
- id (PK)
- reg_no (FK -> students.reg_no)
- staff_email (FK -> staff_accounts.email)
- subject_id (FK -> subjects.id)
- is_active (boolean, default true)
- created_at
- updated_at
- unique(reg_no, staff_email, subject_id)

### submissions (existing, extend)
- include subject_id (FK -> subjects.id) for all new submissions
- enforce that submission is valid only when student has active assignment for that subject

### student_storage_quotas
Track per-student storage usage and limits.
- reg_no (PK, FK -> students.reg_no)
- quota_bytes (not null, default 524288000)
- used_bytes (not null, default 0)
- updated_at

### uploads / submission files (existing, extend)
- ensure each file row has owner reg_no and size_bytes
- include content type and extension metadata
- maintain accurate used_bytes updates on create/delete/archive restore flows

### official_materials
- id (PK)
- subject_id (FK -> subjects.id)
- staff_email (FK -> staff_accounts.email)
- title (not null)
- description (optional)
- file_name (not null)
- mime_type
- size_bytes
- storage_path or file_data reference
- is_active (boolean, default true)
- created_at
- updated_at

### broadcast_messages
- id (PK)
- created_by_staff_email (FK -> staff_accounts.email)
- title (not null)
- message (not null)
- is_active (boolean, default true)
- starts_at (optional)
- expires_at (optional)
- created_at
- updated_at

### user_sessions_live
Operational/session telemetry table (or in-memory + API abstraction) for monitoring.
- id (PK)
- user_role
- user_identifier (reg_no or email)
- login_at
- last_seen_at
- ip_address (optional)
- user_agent (optional)
- is_active

### system_backups
Track backup/restore operations.
- id (PK)
- file_name
- file_size
- checksum
- storage_path
- created_by
- created_at
- restore_tested_at (optional)

## API Requirements
All admin/assignment endpoints must require Super Admin authorization.

### Subject Management (Super Admin)
- POST /api/admin/subjects
- GET /api/admin/subjects
- PATCH /api/admin/subjects/:id
- DELETE /api/admin/subjects/:id (soft delete preferred)

### Staff Management (Super Admin)
- POST /api/admin/staff
- GET /api/admin/staff
- PATCH /api/admin/staff/:email
- POST /api/admin/staff/:email/reset-password
- POST /api/admin/staff/:email/activate
- POST /api/admin/staff/:email/deactivate

### Assignment APIs (Super Admin)
- POST /api/admin/assign/staff-subject
- POST /api/admin/assign/student-subject
- POST /api/admin/assign/student-staff-subject
- DELETE /api/admin/assign/student-staff-subject
- GET /api/admin/assignments/matrix

### Materials APIs
#### Staff
- POST /api/staff/materials (upload material for assigned subject)
- GET /api/staff/materials?subjectId=...
- PATCH /api/staff/materials/:id
- DELETE /api/staff/materials/:id (soft delete)

#### Student
- GET /api/student/materials?subjectId=...

### Broadcast Message APIs
#### Staff/Admin
- POST /api/staff/messages/broadcast
- GET /api/staff/messages/broadcast
- PATCH /api/staff/messages/broadcast/:id
- DELETE /api/staff/messages/broadcast/:id

#### Student
- GET /api/student/messages/broadcast

### Super Admin Operations APIs
- GET /api/superadmin/active-users/live
- POST /api/superadmin/database/backup
- GET /api/superadmin/database/backup/:id/download
- POST /api/superadmin/database/restore (backup upload or backup id)
- POST /api/superadmin/database/wipe (requires confirmation token + phrase)

### Staff Scope APIs
- GET /api/staff/subjects
- GET /api/staff/students?subjectId=...
- GET /api/staff/submissions?subjectId=...

### Student Scope APIs
- GET /api/student/subjects
- GET /api/student/tests?subjectId=...
- POST /api/submissions (must include subjectId)
- GET /api/student/storage/quota (returns used, remaining, total, usagePercent)

### Upload Constraints
- Allowed types: pdf, ppt, pptx, png, jpg, jpeg (optionally doc/docx if enabled by config)
- Reject disallowed mime/extension with 400
- Enforce per-file max size (configurable)
- Enforce per-student total quota 500 MB with 413/409 style quota error response

## Authorization and Validation
1. Verify token role on every request.
2. Staff request must be filtered by assignment tables.
3. Student submission must fail with 403 if assignment does not exist.
4. Reject inactive subjects/staff/assignments.
5. Normalize subject code and reg_no using trim + uppercase.
6. Materials upload must validate subject access and file type/size limits.
7. Broadcast message creation/edit is staff-only; student access is read-only.
8. Super Admin DB operations must require step-up confirmation (password recheck + one-time confirmation phrase).
9. All destructive operations must be idempotent-safe and fully audit logged.
10. On every student upload, validate both file type and remaining quota before writing file/blob.
11. Quota calculations must be transactional to prevent race-condition overuse.

## UI Requirements
### Super Admin Dashboard
Add screens:
- Subject Management: create/edit/activate/deactivate subjects.
- Staff Management: create/edit/deactivate/reset password.
- Assignment Matrix:
  - Filters: subject, staff, section, student.
  - Bulk assign/unassign actions.
  - Clear status indicators for active/inactive mappings.
- Live Active Users panel:
  - Role-wise counters (students, staff, super admins).
  - Real-time active sessions list with last seen timestamp.
  - Optional force logout action per session.
- Database Operations panel:
  - Create backup and download backup file.
  - Upload backup for restore.
  - Wipe database with strong confirmation flow.

### Staff Dashboard
- Subject switcher at top.
- Student list and submissions only for selected subject assignments.
- Reports export by subject.
- Official Materials manager (upload/list/edit/delete by subject).
- Broadcast message composer (send admin announcements to all students).

### Student Dashboard
- Show assigned subjects.
- Submission flow begins with subject selection.
- Submission history grouped by subject.
- Materials tab for assigned subjects.
- Admin announcements feed with unread/read indicator.
- Storage usage widget showing:
  - Used space, remaining space, and 500 MB total.
  - Progress bar with warning state above 80% and blocked state at 100%.
- Upload dialog must show immediate error when quota exceeded or file type is not allowed.

## Migration and Backward Compatibility
1. Seed a default subject for existing records (for example CHEMISTRY) if old submissions have no subject_id.
2. Migrate historical submissions to default subject.
3. Keep existing login/session structure.
4. Existing staff users should continue to log in, but access should be constrained by new assignments.

## Audit and Logs
Add audit entries for:
- Staff creation/update/deactivation.
- Subject creation/update/deactivation.
- Assignment create/remove operations.
- Password reset actions.
- Material upload/update/delete actions.
- Broadcast message create/update/delete actions.
- DB backup/download/restore/wipe actions.
- Session force-logout and monitoring access.
- Quota violations and blocked upload attempts.

Audit fields:
- actor (email/role)
- action
- target_type
- target_id
- before_json
- after_json
- created_at

## Acceptance Criteria
1. Super Admin can create at least 3 subjects and 3 staff accounts.
2. Super Admin can assign one student to different staff for different subjects.
3. Staff A cannot view Student X for Subject B unless explicitly assigned.
4. Student can submit only for assigned subjects.
5. Unauthorized access attempts return 403.
6. Existing data remains usable after migration.
7. Assignment matrix updates reflect in staff/student views without restart.
8. Staff can upload and students can view official materials by subject.
9. Super Admin can back up, download, restore, and wipe DB through guarded APIs/UI.
10. Live active-user monitor displays current sessions accurately.
11. Staff broadcast messages are visible to all students.
12. Student uploads are blocked when cumulative usage exceeds 500 MB.
13. Quota endpoint and UI usage bar stay consistent with actual stored data.

## Suggested Implementation Order
1. DB migrations and seed default subject.
2. Backend models and authorization guards.
3. Super Admin subject and assignment APIs.
4. Staff/student scoped query updates.
5. Frontend screens for Super Admin assignment matrix.
6. Add materials and broadcast message modules (API + UI).
7. Add active-user monitor and DB operations modules for Super Admin.
8. Add per-student quota enforcement in uploads/submissions pipeline.
9. End-to-end tests and regression pass.

## Test Cases (Minimum)
- Create subject, assign staff, assign student-staff-subject, verify visibility.
- Remove assignment and verify access revoked immediately.
- Attempt staff access to unassigned student/subject returns 403.
- Student tries submission for unassigned subject returns 403.
- Inactive subject should not appear in selection lists.
- Bulk assignment import updates matrix correctly.
- Staff uploads material for assigned subject and student can download it.
- Staff upload attempt for unassigned subject returns 403.
- Broadcast message created by staff is visible to all students.
- Super Admin backup file can be downloaded and restore completes successfully.
- Database wipe requires explicit confirmation and is audit logged.
- Live active users endpoint reflects login/logout events within expected delay.
- Student can upload allowed file types until quota reaches 500 MB.
- Upload that exceeds remaining quota is rejected with clear quota error.
- Deleting an uploaded file reduces used quota and allows further uploads.

## Implementation Plan (Feature Backlog)
### Super Admin Controls
- Bulk student import/update from Excel with dry-run preview.
- Bulk assignment wizard (staff-subject-student).
- Staff workload view (students per staff per subject).
- Audit log explorer with filters and export.
- Session control (force logout by user/device).
- Role policy engine (fine-grained permissions).

### Staff Productivity Features
- Bulk test creation (duplicate test to multiple sections/subjects).
- Question bank with reusable templates.
- Batch grading with keyboard shortcuts.
- Auto-feedback snippets (comment presets).
- Export reports in CSV/XLSX/PDF by subject and date range.
- Material versioning (replace file while keeping history).

### High-Impact Features
- Multi-subject + multi-staff assignment matrix.
- Staff official material upload per subject.
- Student 500 MB quota with usage meter and warnings.
- Super Admin live active users monitor.
- Super Admin DB backup, restore, and guarded wipe flow.
- Staff broadcast announcements to all students.
- Subject-wise analytics dashboard (submission rate, average marks, pending grading).

### Operations and Scale
- Background job queue for heavy exports and file processing.
- Scheduled cleanup for old temporary files.
- Storage tiering (local + object storage).
- API health and metrics dashboard (latency, errors, active sessions).
- Centralized logs with searchable traces.
- Feature flags for safe rollout.

### Communication Features
- Announcement channels (global, subject, class, student-specific).
- Scheduled announcements.
- Read receipts for announcements.
- Optional staff-student Q&A thread per assignment.
- Emergency banner mode (top-priority alerts).

### Suggested Rollout Sequence
1. High-Impact Features.
2. Super Admin Controls.
3. Staff Productivity Features.
4. Communication Features.
5. Operations and Scale.

## Prompt Usage
Use this file as the master implementation brief for development tasks.
When generating code, enforce role-based access and subject-specific visibility in both API and UI layers.
