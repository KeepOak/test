# Inbox source change review

The Inbox's Approve step uses the existing owner-only source request API. The owner supplies the
name and every contract term: allowed paths, allowed tools, expected tests, definition of done,
side effects and rollback plan. Approval prepares the contracted worktree; it does not start an
edit task or claim that edits or tests have happened.

After the requested edits have been committed, `GET /api/self-development/requests/:id/draft`
returns the bounded diff, contract and an exact `review` identity. The worktree must be clean.
`POST /api/self-development/requests/:id/publish` takes that unchanged `review`, an owner-written
`title`, `summary` and `consent: true`. It refuses changed contracts, branches, commits, trees,
destinations and files withheld by current privacy rules. The route uses the real durable source
publication queue from the source publisher, including reconciliation and bounded retries.

The owner at this window must remain authorized and unlocked. Household profiles, task calls,
short-lived keys and paired-door calls cannot use the draft action. Current policy and source
contract gates are rechecked before every remote operation and on retries. A draft's saved approval
cannot be reused for a different request or different publication details. A push already accepted
by GitHub remains there if a later check stops the operation; the saved publication status shows
what happened. This route never merges or installs a change and does not assert test acceptance.

The UI consumer is a separate dependent change. The source publisher dependency is PR #890.
After the factory extraction, initialize `SourceRequestDrafts` in `src/branch.ts` after
`pullRequestDeps`, retain its `authorizePublication` callback and return `sourceDrafts` on the app.

Tests not run at owner request. CI intentionally skipped. Real owner approval, GitHub publication,
offline retry and installed Inbox acceptance remain unverified.
