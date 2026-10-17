# EVIDEX API

Evidence-first platform API built with Express and MongoDB/Mongoose. AI-generated analysis is stored separately from user-recorded observations.

## Setup

1. Install Node.js 20+.
2. Run `npm install` in `Backend` and `npm install` in `Frontend`.
3. Copy `Backend/.env.example` to `Backend/.env`. Set `MONGODB_URI` and a random `JWT_SECRET` of at least 32 characters. Set `GEMINI_API_KEY` to enable live Gemini analysis; otherwise Idea Lab returns clearly labelled sample suggestions. Optionally set `DEMO_USER_PASSWORD` (10+ characters) and `DEMO_USER_EMAIL` to seed a labelled demo account; never commit `.env`.
4. Start MongoDB locally or use a MongoDB URI you control.
5. Run `npm run seed` in Backend once, then `npm run dev` there. In a second terminal, run `npm run dev` in Frontend.

API: `http://localhost:4000`; UI: `http://localhost:5173`. `CLIENT_ORIGIN` and `VITE_API_BASE_URL` are configurable. MongoDB is required for application routes and persistent records.

## Core features implemented

- Account registration and sign-in with bcrypt password hashing and signed bearer tokens.
- Owned, private-by-default profile, editable/archiveable projects and evidence records, and explicitly scoped, expiring and revocable profile-share links.
- Admin-managed draft/published/archived tasks with immutable attempt snapshots, required deliverables, versioned submissions/history, persisted completeness-check runs, linked evidence, rubric-bound reviewer decisions, and independent appeals that can reopen a rejected submission for resubmission.
- Idea Lab with Gemini structured JSON output, Zod validation, versioned analysis metadata, labelled sample fallback on missing keys or provider errors, evidence-linked research records, deduplicated experiment plans, and separately stored actual results with optional founder-entered outcome.
- Deterministic skill, linked-evidence, and reviewer-rubric matching with configurable/versioned weights, an explanation, and explicit eligible / not eligible / needs review states.
- Opportunity-specific skill gaps with relevant public practice-task suggestions; recommendations do not automatically alter or verify candidate skills.
- Founder/admin-managed opportunity drafts and publication, explainable matching, persisted applications, owner review/status history, and applicant withdrawal.
- Authenticated dashboard summary derived from the user's saved evidence, verified tasks, review states, recent activity, ideas, planned experiments and latest saved match.
- Seeded example task and two opportunities. Set demo credentials to seed a clearly labelled sample user, Idea Lab response, and task submission. Sample evidence is excluded from matching; no reviews, customer observations, or employment outcomes are fabricated.

## API

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the routes and response shape. Protected routes require `Authorization: Bearer <token>`. Success responses use `{data}`; errors use `{error:{code,message}}`.

The API closes its HTTP listener and MongoDB connection on `SIGINT` or `SIGTERM`, with a 10-second forced-connection-close fallback. Production deployment still needs a target host, production secrets, allowed client origin, and appropriate shared rate-limit storage when running multiple instances.

## Privileged accounts

Public registration only allows `student` and `founder` roles. To provision a reviewer, mentor, or initial admin, first register the account, then run `npm run provision-role -- <email> <role>` from Backend with `.env` configured. This CLI requires direct database access and does not create accounts or passwords. An admin can later change another account's role or suspend it through `PATCH /api/admin/users/:id/access`; access changes are recorded, invalidate the account's existing bearer tokens, and require the user to sign in again. Admins cannot change their own access through that API.

## Verification

See [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md). `npm test` runs 24 unit/schema/service tests; `npm run test:integration` runs a MongoDB-backed API journey when `MONGODB_URI` and `JWT_SECRET` are configured in `.env`. The integration test uses a fresh random `evidex_it_*` database and drops it after the run. The persisted API journey and Atlas connection passed. Live Gemini requests and browser E2E checks remain unverified; they need provider credentials and a running UI/API environment.

## Limitations and planned scope

- A public profile directory/search is not exposed. A user can create an expiring share link with selected fields, projects and evidence; the raw link token is shown once and revocation is server-enforced.
- Verification checks every task-required deliverable for a non-empty submitted value and clearly reports its limits. Public GitHub repository metadata can be checked, but the API does not verify repository ownership, commit authorship/history, code quality, or claims. No sandbox execution, arbitrary source URL accessibility check, similarity service, or authorship determination is implemented.
- Reviewer/admin/mentor accounts cannot be created through public signup. Provision them with the documented local role command. The restricted talent board only shows active student accounts that explicitly opted in; reviewer invitations remain unimplemented.
- Scoped business briefs, Gemini-assisted draft generation, private invite-only brief tasks, candidate invitation/acceptance, and two-party resource swaps are implemented as API workflows. Generated briefs remain drafts and require admin approval before publication; missing/failed Gemini calls return clearly labelled editable sample content.
- Brief-based private team formation supports student-created teams, role labels, opt-in invitations, capacity limits, private submission comparison, and explicit leave/close actions. Automated candidate-to-team matching is not implemented.
- No file uploads, resume parsing, voice input, nearby geospatial search, payments, or proctoring.
- There is no sandbox execution, source URL accessibility check, Git metadata integration, similarity service, or authorship determination. Completeness checks do not verify correctness.
- Live Gemini calls and browser end-to-end checks have not been verified. Hosting and deployment configuration still need a target environment and production secrets.
- Match score weights default to 50% skills, 30% skill-linked evidence, and 20% human rubric performance; configure them in `.env`, and treat them as unvalidated prototype assumptions. Unknown eligibility rules require manual review.
- Gemini output is a suggestion. User observations are separate; sample output is never labelled live.
