# Test plan and verification record

## Automated checks run

- `npm test` — 14 dashboard/matching/model tests passed: persisted-summary derivation, activity ordering, scoring, configurable weights, unknown eligibility handling, excluded evidence statuses, and Mongoose ownership/status schemas.
- `npm run build` in Frontend — production build passed.
- `node --check` across backend JavaScript modules and a dynamic import of the Express app — passed.
- MongoDB Atlas connection and `ping` using the configured Backend environment — passed.
- Gemini fallback exercise without `GEMINI_API_KEY` — sample source label and Zod validation passed.
- API app route modules imported cleanly. A full persisted HTTP workflow was not exercised as part of this run.

## Blocked in this environment

- The configured Atlas database is reachable, but full persisted API journeys and browser-based database flows remain unverified.
- Live Gemini request and browser-based end-to-end checks remain unverified. Configure a key and run both services on a machine that permits local networking.
- `npm audit` could not reach the npm audit endpoint because network name resolution is unavailable. `npm install` reported 3 high-severity findings in Backend and 2 moderate in Frontend; resolve/review them with an online `npm audit` before deployment.

## Manual acceptance flow after setup

1. Start MongoDB, configure `Backend/.env`, then run `npm run seed` and `npm run dev` from Backend.
2. Run `npm run dev` from Frontend and register a student account.
3. Edit the profile, add evidence, refresh, and confirm the saved data remains.
4. Open the seeded research task, submit every required deliverable, and confirm the saved completeness status.
5. Create an idea, analyze it, confirm generated/sample labelling and the `test_planned` lifecycle, then separately save observations and an optional supported/contradicted/inconclusive outcome for a persisted experiment. Reload results and confirm sample data never appears as a real outcome.
6. Calculate a match and inspect matched/missing skills, linked evidence, reviewer rubric contribution, configured formula version, and eligible/not eligible/needs-review status.
7. Try missing/invalid tokens and another user's record IDs. Confirm protected records do not leak.
8. Provision a reviewer account through a controlled admin process, load the review queue, score every configured rubric criterion once, and confirm review history/status plus linked evidence updates.
