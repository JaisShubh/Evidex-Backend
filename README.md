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
- Owned, private-by-default profile, projects, and evidence records.
- Published tasks, attempts bound to task version, required deliverables, versioned submissions/history, persisted completeness-check runs, linked evidence, and rubric-bound reviewer decisions.
- Idea Lab with Gemini structured JSON output, Zod validation, saved analysis metadata, rate limiting, explicitly labelled sample output, experiment plans, and separately stored actual results with optional founder-entered outcome.
- Deterministic skill, linked-evidence, and reviewer-rubric matching with configurable/versioned weights, an explanation, and explicit eligible / not eligible / needs review states.
- Published opportunity browsing and persisted applications.
- Authenticated dashboard summary derived from the user's saved evidence, verified tasks, review states, recent activity, ideas, planned experiments and latest saved match.
- Seeded example task and two opportunities. Set demo credentials to seed a clearly labelled sample user, Idea Lab response, and task submission. Sample evidence is excluded from matching; no reviews, customer observations, or employment outcomes are fabricated.

## API

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the routes and response shape. Protected routes require `Authorization: Bearer <token>`. Success responses use `{data}`; errors use `{error:{code,message}}`.

## Verification

See [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md). `npm test` runs the 15 unit/schema tests; `npm run test:integration` runs a MongoDB-backed API journey when `MONGODB_URI` and `JWT_SECRET` are configured in `.env`. The integration test uses a fresh random `evidex_it_*` database and drops it after the run. The persisted API journey and Atlas connection passed. Live Gemini requests and browser E2E checks remain unverified; they need provider credentials and a running UI/API environment.

## Limitations and planned scope

- Public profile sharing is not exposed; profiles remain accessible only to their owner and authorized reviewers. The visibility field is stored but no public profile endpoint exists.
- Verification checks required submitted fields only. No sandbox execution, URL content verification, Git metadata integration, similarity service, or authorship determination is implemented.
- Reviewer accounts are not created via public signup; provision one explicitly for reviewer workflow testing.
- No file uploads, resume parsing, voice input, location discovery, team builder, scoped business briefs, resource swaps, invitations, payments, or proctoring.
- Match score weights default to 50% skills, 30% skill-linked evidence, and 20% human rubric performance; configure them in `.env`, and treat them as unvalidated prototype assumptions. Unknown eligibility rules require manual review.
- Gemini output is a suggestion. User observations are separate; sample output is never labelled live.
