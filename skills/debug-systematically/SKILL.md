---
name: debug-systematically
description: Find the actual cause of a bug instead of guessing at fixes. Trigger when the user says "this is broken", "why is this failing", "it works locally but not in CI", "intermittent failure", "flaky test", "I've tried everything", pastes a stack trace or error log, or when two attempted fixes in a row have not worked.
---

# Debugging systematically

Guess-and-check debugging works on easy bugs, which is why it feels like it works. On hard
bugs it burns hours and leaves behind speculative changes nobody dares remove. Switch to
this procedure the moment your second guess fails.

## Step 0 — Check memory first

Before reproducing anything, search past sessions for the literal error string and for the
failing file's path. Bugs recur: same test goes flaky again after a dependency bump, same
timezone bug at the same month boundary. A hit here can end the whole exercise in one step.
Note the date on any hit — a fix from before a major refactor may no longer apply.

## Step 1 — Reproduce, then shrink

You cannot debug what you cannot trigger on demand.

- Write down the exact invocation that fails and the exact observed output. "It's broken"
  is not a reproduction; a command and its output is.
- Then **shrink it**. Cut inputs, steps, and configuration until removing anything more
  makes the failure disappear. Each thing you remove is a variable eliminated for free.
- If it reproduces only sometimes, record the hit rate (`3 of 20 runs`). You need that
  number later to tell a fix from luck — one green run after a change proves nothing about
  a bug that fails 1 in 10.

**If you genuinely cannot reproduce it**, stop debugging and start instrumenting. Add
logging around the suspected region, ship it, and wait for the next occurrence. Fixing an
unreproduced bug is guessing with extra steps.

## Step 2 — Bracket it

Find the boundary between "state is correct" and "state is wrong". You are looking for one
transition, not for the bug.

- Pick a point midway through the failing path. Assert what should be true there. Correct?
  The fault is downstream. Wrong? It's upstream. Repeat.
- Across time rather than code, use `git bisect` — but only with a scripted test that exits
  non-zero on the bug. Bisecting by hand on a flaky failure produces a confidently wrong
  commit.
- Across environments (works locally, fails in CI), enumerate the differences explicitly —
  versions, env vars, filesystem case sensitivity, timezone, CPU count, network egress,
  clock skew — and eliminate them one at a time. The answer is almost always in that list,
  and it is almost never the one you assumed.

## Step 3 — Explain it before you fix it

Do not touch the code until you can state the mechanism as a causal chain:

> `parse_date` gets an empty string because the CSV has a trailing blank line, so it returns
> `None`, so the sort comparator raises on `None < datetime`.

Then verify the explanation *predicts something you haven't observed yet* — "if this is
right, a file without a trailing newline will pass". Check that prediction. If it fails,
your explanation is wrong and the fix built on it would have been a coincidence.

Signals that you don't actually have the mechanism yet: "it's a race condition somewhere",
"something with caching", "the library is buggy". These are categories, not causes.

## Step 4 — Fix at the right level

Once the chain is known, choose deliberately where to cut it:

- **Fix the origin** when the bad state has one clear source — reject the blank row at parse
  time. Preferred: it fixes every downstream symptom at once.
- **Fix the propagation** when the origin is outside your control (third-party API, legacy
  caller). Validate at your boundary and fail loudly there, not deep in the call stack.
- **Fix the symptom only** when you are mid-incident and need the bleeding stopped. This is
  legitimate — but it is a *second* fix, not the fix. Leave a comment naming the real cause
  and open the follow-up before you move on.

Reject any fix you cannot justify. `if x is not None:` wrapped around the crash site, added
without knowing why `x` was `None`, converts a loud bug into a silent one.

## Step 5 — Prove it and lock it in

- Write a test that fails on the old code and passes on the new one. Confirm both
  directions — a test that passes before your fix is testing nothing.
- For intermittent bugs, re-run to the hit rate you measured in step 1. If it failed 3 in
  20, run 40 clean before you believe it.
- Remove every probe, log line, and speculative edit you added while hunting. Ship only the
  fix and the test.
- Capture what you learned: the symptom, the true cause, and the misleading signal that
  cost you time. The last part is the valuable one — next time the same misleading signal
  appears, the record turns an afternoon into a minute. Use `capture-decision` if the fix
  also constrains future work.

## Time boxes

- 30 minutes with no narrowing of the search space → re-read the error message literally,
  word by word. It very often says exactly what is wrong and was skimmed.
- 90 minutes → explain the problem out loud to the user, including what you've ruled out.
  Stating it plainly is itself a debugging technique, and the user may know something.
- Two fixes that didn't work → return to step 2. You are debugging your theory, not the bug.
