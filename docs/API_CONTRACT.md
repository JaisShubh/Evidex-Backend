# API contract
All endpoints are prefixed `/api`; protected routes require a bearer JWT. Success responses use `{data: ...}`. Errors use `{error:{code,message,details?}}`.

| Method | Endpoint | Access | Behavior |
|---|---|---|---|
| GET | `/health` | Public | API and database status |
| POST | `/auth/register`, `/auth/login` | Public | Account creation/sign-in |
| GET/PATCH | `/profile/me` | User | Read/update own profile |
| POST | `/projects`, `/evidence` | User | Create owned records |
| GET | `/evidence/me` | Owner | List own evidence records |
| GET | `/tasks`, `/tasks/:id` | User | List/read published tasks |
| POST | `/tasks/:id/attempts` | User | Start versioned attempt |
| POST | `/attempts/:id/submissions` | Owner | Create versioned submission |
| GET/POST | `/submissions/:id/verification`, `/verify` | Owner/reviewer | Read/run completeness check |
| POST | `/submissions/:id/reviews` | Reviewer/admin | Persist human review |
| GET/POST | `/ideas` | User | List/create own ideas |
| POST | `/venture/deconstruct` | Owner | Analyze saved idea (sample fallback labelled) |
| GET | `/ideas/:id/analyses` | Owner | List analysis history |
| GET | `/ideas/:id/experiments` | Owner | List saved experiments and statuses |
| GET | `/ideas/:id/experiments` | Owner | List saved experiments and statuses |
| POST | `/experiments/:id/results` | Owner | Record actual user observation; linked evidence must belong to the user |
| GET | `/opportunities` | User | Published opportunities |
| POST | `/match/calculate` | User | Save deterministic explainable match |
| GET | `/matches/me` | User | Own match history |
| POST | `/opportunities/:id/applications` | User | Apply; duplicate rejected |

Task and evidence status meanings are represented by explicit enum values in schemas. Match weights are prototype assumptions: 50% skills, 30% relevant evidence, 20% verified evidence.
