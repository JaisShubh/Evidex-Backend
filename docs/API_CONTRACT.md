# API contract

All endpoints are prefixed `/api`; protected routes require a bearer JWT. Success responses use `{data: ...}`. Errors use `{error:{code,message,details?}}`.

| Method | Endpoint | Access | Behavior |
|---|---|---|---|
| GET | `/health` | Public | API and database status |
| POST | `/auth/register`, `/auth/login` | Public | Account creation/sign-in |
| GET/PATCH | `/profile/me` | User | Read/update own profile |
| GET | `/dashboard` | User | Actual evidence, task, review, activity, idea and latest-match summary |
| GET/POST | `/projects/me`, `/projects` | Owner | List/create own projects |
| GET/POST | `/evidence/me`, `/evidence` | Owner | List/create own evidence records |
| GET | `/tasks`, `/tasks/:id` | User | List/read published tasks |
| POST | `/tasks/:id/attempts` | User | Start versioned attempt |
| POST | `/attempts/:id/submissions` | Owner | Create first submission or versioned resubmission after changes are requested |
| GET | `/submissions/me`, `/attempts/:id/submissions` | Owner | Reload submission and attempt history |
| GET | `/submissions/:id/verification` | Owner/reviewer | Read persisted verification and review history |
| POST | `/submissions/:id/verify` | Owner | Save a completeness check |
| GET | `/reviews/queue` | Reviewer/admin | List submissions awaiting human review |
| GET | `/submissions/:id/reviews` | Owner/reviewer | Read permitted review history |
| POST | `/submissions/:id/reviews` | Reviewer/admin | Persist rubric-bound human review |
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
