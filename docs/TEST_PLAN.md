# Test plan and verification record

## Automated checks run

- `npm test` — 21 unit/schema/service tests passed; the MongoDB integration test is skipped by default unless enabled.
- GitHub metadata service tests — URL allowlisting/canonicalization, restricted metadata fields, missing/private response handling, and bounded provider errors passed with mocked fetch responses.
- `npm audit` — 0 vulnerabilities after removing the dev-only `nodemon` dependency chain and using Node 20's built-in `--watch` mode.
- `npm run test:integration` with `EVIDEX_INTEGRATION_TESTS=true` and configured `MONGODB_URI`/`JWT_SECRET` — passed against Atlas. It creates a uniquely named temporary database, runs the API journey, then drops that database. Coverage includes registration, missing/invalid/revoked tokens, public role escalation rejection, admin role/suspension changes and access history, role and owner checks, profile/project/evidence create/update/archive persistence and scoped/expiring/revocable sharing, explicit talent-board consent/search/revocation, owner-scoped public GitHub metadata checks with mocked provider response, admin task creation/publication/versioning/archiving with attempt snapshots, submission/completeness verification/reviewer decision/independent appeal and resubmission, Idea Lab idea edit, evidence-linked research, labelled fallback analysis, deduplicated experiments and saved results, private business brief approval/publication, opt-in invitations and private task access, two-party resource swap lifecycle, founder/admin opportunity publishing, matching, application status history, withdrawal and duplicate rejection, and dashboard counts.
- `npm run build` in Frontend — production build passed.
- `node --check` across backend JavaScript modules and a dynamic import of the Express app — passed.
- MongoDB Atlas connection and `ping` using the configured Backend environment — passed.
- Gemini unit checks — missing-key and simulated provider-error cases both return labelled sample data without leaking provider diagnostics.
- API app route modules imported cleanly.
- Server module syntax check passed after adding `SIGINT`/`SIGTERM` graceful HTTP and MongoDB shutdown handling.

## Blocked in this environment

- Browser-based database flows remain unverified.
- Live Gemini request and browser-based end-to-end checks remain unverified. Configure a key and run both services on a machine that permits local networking.
- Frontend dependency audit status is tracked separately in the Frontend repository; this backend audit does not cover frontend dependencies.

## Manual acceptance flow after setup

1. Start MongoDB, configure `Backend/.env`, then run `npm run seed` and `npm run dev` from Backend.
2. Run `npm run dev` from Frontend and register a student account.
3. Edit the profile, add evidence, refresh, and confirm the saved data remains.
4. Open the seeded research task, submit every required deliverable, and confirm the saved completeness status.
5. Create an idea, analyze it, confirm generated/sample labelling and the `test_planned` lifecycle, then separately save observations and an optional supported/contradicted/inconclusive outcome for a persisted experiment. Reload results and confirm sample data never appears as a real outcome.
6. Calculate a match and inspect matched/missing skills, linked evidence, reviewer rubric contribution, configured formula version, and eligible/not eligible/needs-review status.
7. Try missing/invalid tokens and another user's record IDs. Confirm protected records do not leak.
8. Provision a reviewer account through a controlled admin process, load the review queue, score every configured rubric criterion once, and confirm review history/status plus linked evidence updates.
