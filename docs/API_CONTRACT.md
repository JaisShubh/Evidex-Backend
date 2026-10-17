# API contract

All endpoints are prefixed `/api`; protected routes require a bearer JWT. Success responses use `{data: ...}`. Errors use `{error:{code,message,details?}}`.

| Method | Endpoint | Access | Behavior |
|---|---|---|---|
| GET | `/health` | Public | API and database status |
| POST | `/auth/register`, `/auth/login` | Public | Account creation/sign-in |
| GET/PATCH | `/profile/me` | User | Read/update own profile |
| POST/DELETE | `/talent-board/consent` | Student | Explicitly opt in to, or revoke, discoverability |
| GET | `/talent-board/candidates` | Reviewer/mentor/admin | Search consenting active student profiles by skill, location, or preferred role; response omits email and evidence records |
| POST | `/profile/shares` | Owner | Create an expiring share scoped to selected profile fields/projects/evidence; returns a one-time share token |
| GET | `/profile/shares/me` | Owner | List own shares without token hashes |
| DELETE | `/profile/shares/:id` | Owner | Revoke an active share |
| GET | `/shared/profile` | Share token | Read only the profile fields/projects/evidence granted by `X-Profile-Share` |
| PATCH | `/admin/users/:id/access` | Admin | Change another account's role/status; records the change and invalidates existing tokens |
| GET | `/admin/users/:id/access-history` | Admin | Read account role/status change history |
| GET | `/dashboard` | User | Actual evidence, task, review, activity, idea and latest-match summary |
| GET/POST/PATCH/DELETE | `/projects/me`, `/projects`, `/projects/:id` | Owner | List/create/update/archive own projects |
| GET/POST | `/projects/:id/repository-checks` | Project owner | Check/read a history of public GitHub repository metadata; bounded to GitHub URLs and rate limited |
| GET/POST/PATCH/DELETE | `/evidence/me`, `/evidence`, `/evidence/:id` | Owner | List/create/update/archive own evidence; task-submission evidence is system-managed |
| GET | `/tasks`, `/tasks/:id` | User | List/read published tasks |
| GET/POST/PATCH/DELETE | `/admin/tasks`, `/admin/tasks/:id` | Admin | Manage drafts, publish/version tasks, or archive them |
| POST | `/admin/tasks/generate-draft` | Admin | Generate a structured Gemini-assisted task draft (10 requests/hour); sample fallback is labelled; task remains unpublished |
| POST | `/tasks/:id/attempts` | User | Start versioned attempt |
| POST | `/attempts/:id/submissions` | Owner | Create first submission or versioned resubmission after changes are requested |
| GET | `/submissions/me`, `/attempts/:id/submissions` | Owner | Reload submission and attempt history |
| GET | `/submissions/:id/verification` | Owner/reviewer | Read persisted verification and review history |
| POST | `/submissions/:id/verify` | Owner | Save a completeness check |
| GET | `/reviews/queue` | Reviewer/admin | List submissions awaiting human review |
| POST | `/submissions/:id/score-suggestions` | Reviewer/admin | Request a stored advisory rubric suggestion; body must include `{"confirmShareWithGemini":true}` before submission content may be sent to Gemini; never changes submission status |
| GET | `/submissions/:id/score-suggestions` | Reviewer/admin | Read stored AI/sample suggestions for a submission |
| GET | `/submissions/:id/reviews` | Owner/reviewer | Read permitted review history |
| POST | `/submissions/:id/reviews` | Reviewer/admin | Persist rubric-bound human review |
| POST | `/submissions/:id/appeals` | Owner | Appeal a rejected submission once |
| GET | `/appeals/me` | User | List own appeals |
| GET | `/appeals/queue` | Reviewer/admin | List pending appeals |
| POST | `/appeals/:id/resolve` | Independent reviewer/admin | Uphold or overturn an appeal; an overturned rejection returns to Changes Requested |
| GET/POST | `/ideas` | User | List/create own ideas |
| GET/PATCH | `/ideas/:id` | Owner | Read/update own idea fields |
| GET/POST | `/ideas/:id/research` | Owner | Link owned evidence sources and record research notes |
| POST | `/venture/deconstruct` | Owner | Analyze saved idea (sample fallback labelled) |
| GET | `/ideas/:id/analyses` | Owner | List analysis history |
| GET | `/ideas/:id/experiments` | Owner | List saved experiments and statuses |
| GET | `/ideas/:id/results` | Owner | Reload user-recorded experiment results |
| POST | `/experiments/:id/results` | Owner | Record actual observations and optional outcome; linked evidence must belong to the user |
| GET/POST/PATCH/DELETE | `/briefs`, `/briefs/:id` | Founder/admin | Manage private business briefs; AI-sourced drafts require admin approval before publication |
| GET | `/briefs` | User | List published brief summaries |
| POST | `/briefs/generate-draft` | Founder/admin | Generate a structured Gemini-assisted draft (10 requests/hour); sample fallback is labelled and remains a draft |
| POST | `/briefs/:id/publish` | Founder/admin | Publish a brief as a private invite-only task |
| POST | `/briefs/:id/approve` | Admin | Approve an AI-sourced brief before publication |
| POST | `/briefs/:id/invitations` | Brief owner/admin | Invite an active candidate account to a published private brief |
| GET | `/invitations/me` | User | View invitations addressed to the current user |
| POST | `/invitations/:id/respond` | Invitee | Accept or decline; acceptance records consent and grants access to the private task |
| GET | `/briefs/:id/submissions` | Brief owner/admin | Review submissions to a private brief task |
| POST/GET | `/teams`, `/teams/me` | Invited student | Create a private team for an accepted brief and list own teams |
| GET | `/teams/:id` | Team member | Read team details; other users receive not found |
| GET | `/teams/:id/submissions` | Active team member | Compare task submissions from current team members for the same brief |
| POST | `/teams/:id/invitations` | Team owner | Invite an active student while the team has capacity |
| GET | `/team-invitations/me` | Student | List invitations addressed to the current user |
| POST | `/team-invitations/:id/respond` | Invitee | Accept/decline; acceptance records consent and grants private task access while on the team |
| POST | `/teams/:id/leave`, `/teams/:id/close` | Team member/owner | Leave a team or close it; closure cancels pending team invitations |
| GET/POST | `/resource-swaps/me`, `/resource-swaps` | Participants/user | Propose non-monetary swaps and list own swaps |
| GET | `/resource-swaps/:id` | Participant | Read a swap visible only to its two parties |
| POST | `/resource-swaps/:id/respond`, `/confirm`, `/cancel` | Participant | Accept/decline, confirm both-party completion, or cancel an open swap |
| GET | `/opportunities` | User | Published opportunities |
| GET | `/opportunities/:id/skill-gaps` | User | Compare required skills against own profile and suggest public practice tasks |
| GET/POST | `/owner/opportunities` and `/opportunities` | Founder/admin | List owned opportunities or create a draft |
| PATCH/DELETE | `/opportunities/:id` | Owner/admin | Edit a draft or close an opportunity; admins may publish |
| GET | `/opportunities/:id/applications` | Owner/admin | List applicant IDs and application status without exposing applicant profiles |
| POST | `/match/calculate` | User | Save deterministic explainable match |
| GET | `/matches/me` | User | Own match history |
| GET/POST | `/applications/me`, `/opportunities/:id/applications` | User | List own applications / apply; duplicate rejected |
| PATCH | `/applications/:id/status` | Opportunity owner/admin | Record reviewing/accepted/rejected decision history |
| POST | `/applications/:id/withdraw` | Applicant | Withdraw own open application |

Task and evidence status meanings are explicit enum values in schemas. Match weights default to 50% skills, 30% title-linked relevant evidence, and 20% human rubric performance. Configure `MATCH_SKILL_WEIGHT`, `MATCH_EVIDENCE_WEIGHT`, and `MATCH_TASK_WEIGHT`; they must sum to 100. `MATCH_FORMULA_VERSION` is saved with each result. Unsupported mandatory eligibility rules are marked `needs_review`, never silently treated as passing.

`POST /submissions/:id/verify` checks that each task-required deliverable has a non-empty submitted value. `checks_passed` means this completeness check passed; it does not mean task correctness, source accessibility, authorship, or originality was verified. The response includes warnings naming those unsupported checks.

Starting an attempt stores a snapshot of its task instructions, deliverables, required skills and rubric. Later admin edits increment the task version and affect new attempts only; submissions, verification and reviews for existing attempts continue to use their snapshot.

Profile sharing is explicit and link-based. Shares expire in 1-30 days (7 by default), store only a SHA-256 token hash, and can be revoked by the owner. The public response never includes account email and returns only the selected fields and records. A general public directory is not implemented.

The talent board is separate from profile `visibility`. A student must call `POST /talent-board/consent` before becoming searchable, and can immediately revoke consent with `DELETE`. Only reviewers, mentors, and admins may search. Results include a candidate ID, display name, bio, preferred role, location, skills/proficiency, and consent timestamp; they omit email and linked evidence. Suspended users and non-student accounts are excluded.

Idea analyses save model, schema and prompt versions. If Gemini is missing or fails, the endpoint saves and labels the sample response rather than claiming a live result. Repeated analyses retain history and reuse an existing experiment with the same hypothesis. User research evidence and actual experiment results remain separate from AI suggestions.

Business briefs can be generated with Gemini or returned as clearly labelled sample drafts, then edited before publication. Generated briefs remain private drafts and require admin approval before publishing. Briefs can be converted to private invite-only tasks. Only active account holders can be invited; candidates must accept before reading the brief or task, and acceptance records consent. Invited students can create a private team on a brief they accepted; team invitees consent by accepting, gain task access while members, and lose team-derived access after leaving or closure. Team members can compare one another's task submissions, and invitations can carry a role label. Team membership is limited to 2–8 and does not provide automated candidate matching. Resource swaps are bilateral records with participant-only access and require both participants to confirm completion. The API records agreement and confirmations; it does not enforce delivery, assess disputes, or process payment.

Project and user-reported evidence `DELETE` operations archive records with a timestamp; they do not permanently erase their history. Archived records disappear from normal lists, dashboard counts, matching, and new shares. Editing user-reported evidence resets its provenance/status to `user_reported`/`submitted`. Evidence tied to a task submission cannot be edited or archived.

Repository checks only request metadata from GitHub's fixed API host for canonical HTTPS `github.com/{owner}/{repo}` URLs. A public result confirms that GitHub returned public repository metadata at the recorded time. A 404 is ambiguous between missing and private repositories. Neither outcome proves that the user owns the repository, wrote its code, or completed the listed work. Private repository OAuth, commit analysis, source retrieval, and similarity checks are not implemented.
