# API contract

All endpoints are prefixed `/api`; protected routes require a bearer JWT. Success responses use `{data: ...}`. Errors use `{error:{code,message,details?}}`.

| Method | Endpoint | Access | Behavior |
|---|---|---|---|
| GET | `/health` | Public | API and database status |
| POST | `/auth/register`, `/auth/login` | Public | Account creation/sign-in |
| GET/PATCH | `/profile/me` | User | Read/update own profile |
| POST | `/profile/shares` | Owner | Create an expiring share scoped to selected profile fields/projects/evidence; returns a one-time share token |
| GET | `/profile/shares/me` | Owner | List own shares without token hashes |
| DELETE | `/profile/shares/:id` | Owner | Revoke an active share |
| GET | `/shared/profile` | Share token | Read only the profile fields/projects/evidence granted by `X-Profile-Share` |
| PATCH | `/admin/users/:id/access` | Admin | Change another account's role/status; records the change and invalidates existing tokens |
| GET | `/admin/users/:id/access-history` | Admin | Read account role/status change history |
| GET | `/dashboard` | User | Actual evidence, task, review, activity, idea and latest-match summary |
| GET/POST/PATCH/DELETE | `/projects/me`, `/projects`, `/projects/:id` | Owner | List/create/update/archive own projects |
| GET/POST/PATCH/DELETE | `/evidence/me`, `/evidence`, `/evidence/:id` | Owner | List/create/update/archive own evidence; task-submission evidence is system-managed |
| GET | `/tasks`, `/tasks/:id` | User | List/read published tasks |
| GET/POST/PATCH/DELETE | `/admin/tasks`, `/admin/tasks/:id` | Admin | Manage drafts, publish/version tasks, or archive them |
| POST | `/tasks/:id/attempts` | User | Start versioned attempt |
| POST | `/attempts/:id/submissions` | Owner | Create first submission or versioned resubmission after changes are requested |
| GET | `/submissions/me`, `/attempts/:id/submissions` | Owner | Reload submission and attempt history |
| GET | `/submissions/:id/verification` | Owner/reviewer | Read persisted verification and review history |
| POST | `/submissions/:id/verify` | Owner | Save a completeness check |
| GET | `/reviews/queue` | Reviewer/admin | List submissions awaiting human review |
| GET | `/submissions/:id/reviews` | Owner/reviewer | Read permitted review history |
| POST | `/submissions/:id/reviews` | Reviewer/admin | Persist rubric-bound human review |
| POST | `/submissions/:id/appeals` | Owner | Appeal a rejected submission once |
| GET | `/appeals/me` | User | List own appeals |
| GET | `/appeals/queue` | Reviewer/admin | List pending appeals |
| POST | `/appeals/:id/resolve` | Independent reviewer/admin | Uphold or overturn an appeal; an overturned rejection returns to Changes Requested |
| GET/POST | `/ideas` | User | List/create own ideas |
| POST | `/venture/deconstruct` | Owner | Analyze saved idea (sample fallback labelled) |
| GET | `/ideas/:id/analyses` | Owner | List analysis history |
| GET | `/ideas/:id/experiments` | Owner | List saved experiments and statuses |
| GET | `/ideas/:id/results` | Owner | Reload user-recorded experiment results |
| POST | `/experiments/:id/results` | Owner | Record actual observations and optional outcome; linked evidence must belong to the user |
| GET | `/opportunities` | User | Published opportunities |
| POST | `/match/calculate` | User | Save deterministic explainable match |
| GET | `/matches/me` | User | Own match history |
| GET/POST | `/applications/me`, `/opportunities/:id/applications` | User | List own applications / apply; duplicate rejected |

Task and evidence status meanings are explicit enum values in schemas. Match weights default to 50% skills, 30% title-linked relevant evidence, and 20% human rubric performance. Configure `MATCH_SKILL_WEIGHT`, `MATCH_EVIDENCE_WEIGHT`, and `MATCH_TASK_WEIGHT`; they must sum to 100. `MATCH_FORMULA_VERSION` is saved with each result. Unsupported mandatory eligibility rules are marked `needs_review`, never silently treated as passing.

`POST /submissions/:id/verify` checks that each task-required deliverable has a non-empty submitted value. `checks_passed` means this completeness check passed; it does not mean task correctness, source accessibility, authorship, or originality was verified. The response includes warnings naming those unsupported checks.

Starting an attempt stores a snapshot of its task instructions, deliverables, required skills and rubric. Later admin edits increment the task version and affect new attempts only; submissions, verification and reviews for existing attempts continue to use their snapshot.

Profile sharing is explicit and link-based. Shares expire in 1-30 days (7 by default), store only a SHA-256 token hash, and can be revoked by the owner. The public response never includes account email and returns only the selected fields and records. A general public directory is not implemented.

Project and user-reported evidence `DELETE` operations archive records with a timestamp; they do not permanently erase their history. Archived records disappear from normal lists, dashboard counts, matching, and new shares. Editing user-reported evidence resets its provenance/status to `user_reported`/`submitted`. Evidence tied to a task submission cannot be edited or archived.
