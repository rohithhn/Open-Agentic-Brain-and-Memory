---
name: write-tests
description: Decide what to test, at what level, and write the tests. Trigger when the user says "write tests for this", "add test coverage", "what should I test here", "should this be a unit test", "how do I test this", "these tests are slow/flaky", or after implementing a feature that has no tests.
---

# Writing tests that earn their keep

Every test costs something forever: runtime on every commit, and a small tax on every
future refactor. A test is worth writing when the cost of the bug it catches exceeds that.
Most codebases are simultaneously under-tested at the boundaries and over-tested in the
middle.

## What to test — pick by failure cost

Rank candidates by *what breaks if this is wrong*, not by what's easy to test:

1. **Rules that cost money or trust when wrong** — pricing, permissions, tax, retries,
   deduplication, anything financial or security-related. Test these exhaustively,
   including the ugly cases.
2. **Code with real branching** — anything with meaningful conditionals, precedence rules,
   or state transitions. Branch count is the best cheap proxy for where bugs live.
3. **Boundaries you don't control** — parsers, deserializers, API clients, anything reading
   a file or a request body. Malformed input arrives eventually; test that it's rejected
   cleanly rather than half-processed.
4. **Every bug you fix** — a regression test at the exact reproduction is the highest-value
   test in the suite, because you have proof that failure mode is reachable.

Do **not** write tests for: getters and setters, straight-line delegation with no logic,
framework behaviour (the framework has its own tests), or generated code. Coverage on those
buys a number, not safety.

## Choosing the level

This is the decision that determines whether the suite stays useful. Ask: **where does this
code's correctness actually live?**

**Unit test** when the logic is self-contained and the interesting part is the computation.
Pure functions, calculators, validators, state machines, formatters. Fast, exact, and you
can afford dozens of cases. If it needs more than one or two mocks to stand up, that's a
signal it isn't really a unit — see below.

**Integration test** when the correctness lives in the *seam* — how your code and the
dependency agree. Test at this level when:
- The code's job is mostly to talk to something (a repository, a query builder, an HTTP
  client). A unit test here asserts your mock, not your code.
- The bug you're worried about is a mismatch: wrong column name, wrong serialization, a
  transaction that doesn't roll back, a constraint that fires. Mocks cannot catch any of
  these, because you write the mock from the same wrong assumption as the code.
- You just wrote three mocks to test one function. That's the level telling you it's wrong.

Use a real dependency here where you can — an actual database in a container, a temp
directory, a local fake of the API. A real Postgres catches the wrong-column-name bug; a
mocked repository never will.

**End-to-end test** only for a handful of paths whose breakage is unacceptable: log in,
check out, submit, save. These are slow and the flakiest thing you own, so keep the count
small and deliberate. If you have more than a dozen, you are paying integration-level cost
for e2e-level flakiness.

**The heuristic:** push each test to the *lowest* level that can still catch the bug you
are actually worried about. Not lower — a fast test that cannot fail for the real reason is
worse than no test, because it produces confidence.

## Writing the case

- **One behaviour per test.** When it fails, the name should tell you what broke without
  reading the body. `rejects_order_when_inventory_is_zero`, not `test_order_2`.
- **Arrange, act, assert — visibly separated.** If the arrange block is longer than the
  other two combined, the code under test has too many dependencies; that's a design signal
  worth mentioning to the user.
- **Assert on observable behaviour**, not internals. Check the returned value, the emitted
  event, the row that ended up in the table. Asserting that a private method was called
  once locks the implementation in place and breaks on every honest refactor.
- **Make it deterministic.** Inject the clock and the random seed. Never assert on wall
  time, iteration order of an unordered collection, or "should finish within 200ms".
- **Fixtures should show the relevant fact.** Build objects with only the fields the test
  cares about set explicitly; let a factory fill the rest. A test whose input is 40 lines
  of JSON hides which field mattered.
- **Verify the test can fail.** Break the code deliberately and watch it go red — once. A
  test that has never failed is an unverified assertion.

## Choosing the cases

For a function with a real input domain, cover:
- one representative happy path (not five — they all exercise the same branch),
- each boundary: empty, one, many, zero, negative, maximum, null/absent,
- each error path, asserting the *specific* failure, not just "raises",
- any case a past bug proves is reachable.

When the input space is large and the rule is simple (round-trips, idempotence,
commutativity, "output is always sorted"), property-based testing beats a table of examples
— it finds the case you wouldn't have thought of, and shrinks it for you.

## Dealing with a flaky test

Flaky tests destroy the suite's authority faster than missing tests do, because people start
re-running red builds by reflex. Fix or delete — never leave a known-flaky test green-ish.

Usual causes, in order of frequency: shared state between tests (a database not reset, a
module-level cache, a singleton), real time or real sleeps, ordering assumptions on
unordered data, and genuine concurrency in the code under test. Only the last one is a bug
in the product; the rest are bugs in the test. Diagnose before quarantining — and if you
quarantine, capture why, so the next person doesn't rediscover it.
