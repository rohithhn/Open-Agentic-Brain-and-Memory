---
name: review-changes
description: Review an uncommitted or unmerged diff for correctness and risk before it ships. Trigger when the user says "review this", "review my changes", "check this diff", "is this ready to commit", "look over the PR", "did I miss anything", or before committing a change of non-trivial size.
---

# Reviewing a working diff

The purpose of a review is to find the thing that will break in production, not to produce
a list of observations. A review that surfaces one real bug is worth more than one that
returns twenty style notes.

## Read the diff in the right order

1. **Get the whole diff first** — `git diff` for unstaged, `git diff --staged`, or
   `git diff <base>...HEAD` for a branch. Never review a fragment the user pasted without
   checking whether it's the complete change.
2. **Establish intent before reading code.** What is this change supposed to do? Ask if it
   isn't clear. Without intent you can only check for syntax problems, and the compiler
   already did that.
3. **Read deleted lines as carefully as added ones.** Removed guard clauses, removed
   `await`, removed error branches, and removed tests are where the sharpest bugs hide, and
   they are the easiest lines to skim past.
4. **Then read the files the diff calls into** — not just the changed ones. Most real bugs
   in a diff are contract violations against unchanged code.

## Correctness pass — in priority order

Work down this list. Stop and report as soon as you find something in the first two tiers;
don't save it for a tidy summary at the end.

**Tier 1 — will corrupt or leak**
- Data loss: a migration that drops or rewrites a column, a delete without a `where`, an
  overwrite where an append was meant.
- Authorization: a new route, query, or handler that doesn't apply the ownership or tenancy
  filter its neighbours apply. Compare against the sibling endpoint.
- Secrets and PII: keys or tokens in code, config, or fixtures; identifiers newly written
  into logs.
- Injection: string-built SQL, shell, or HTML anywhere near a value that came from outside.

**Tier 2 — will break**
- Boundaries: empty collection, single element, null/undefined, zero, negative, maximum
  length. Trace one of each through the new code path.
- Errors: what happens when the call this diff added fails? Is the failure caught somewhere
  that can do something about it, or swallowed?
- Concurrency: read-then-write without a lock or a conditional update; `await` inside a
  loop that assumed sequential state; shared mutable state added to a request handler.
- Resources: opened files, connections, subscriptions, or timers with no matching close on
  the error path.
- Compatibility: a changed function signature, response field, event shape, or config key,
  with old callers or old persisted data still in flight.

**Tier 3 — will cost later**
- N+1 queries introduced inside a loop; an unbounded fetch where the data set grows.
- Duplicated logic that now has two places to fix.
- A test that asserts the implementation rather than the behaviour, and will break on the
  next refactor for no reason.

## Risk pass — questions about the change as a whole

- **Blast radius.** How many callers touch the changed function? A one-line edit to a
  utility used in 40 places is a bigger change than 300 new lines in an isolated module.
- **Reversibility.** If this is wrong in production, can it be reverted cleanly? Schema
  changes, data backfills, and anything that writes to an external system are one-way; they
  deserve proportionally more scrutiny than code that can be rolled back.
- **Tests.** Does a new test actually exercise the new behaviour, and would it have failed
  before this change? Untested error paths and untested boundaries are the tests most often
  missing.
- **Scope creep.** Unrelated refactors bundled into a behavioural change make both harder
  to review and impossible to revert independently. Say so and suggest splitting.
- **Leftovers.** Debug prints, commented-out code, `TODO` without an owner, temporary
  timeouts bumped during debugging and never restored, `.only` on a test.

## Cross-check against past decisions

Search memory for the files in the diff before you finalize. If a past decision record says
"order IDs are strings because a partner sends non-numeric IDs" and this diff casts them to
int, that is a Tier 1 finding you would not otherwise catch from the code alone. This check
is cheap and it catches the class of bug that unit tests never do — the deliberate constraint
someone silently undid.

## How to report

Group by severity, lead with the worst, and make every item actionable:

- **Must fix** — with the file, the line, the concrete failure scenario, and the change.
  *"`sync.py:88` — `--force` skips the confirmation prompt but not the backup, so a failed
  sync now overwrites the last good blob. Move the backup above the branch."*
- **Should fix** — real, but survivable if the change is urgent.
- **Consider** — judgement calls. Say plainly that they're optional.

Two things that make a review trustworthy: state explicitly what you did **not** check
("I didn't verify the migration against production-shaped data"), and say clearly when the
diff is fine. A reviewer who always finds something is not a reviewer, they're a filter
everyone learns to route around.
