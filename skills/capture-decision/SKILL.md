---
name: capture-decision
description: Record a technical decision so future sessions inherit it instead of relitigating it. Trigger when the user says "let's go with X", "remember that we decided", "note this for later", "we're not doing Y because", "write this down", when a design debate resolves, or immediately after a non-obvious tradeoff is settled in conversation.
---

# Capturing a decision

A decision is worth capturing when a future reader — including a future session with no
memory of this conversation — would otherwise look at the code and ask "why on earth is it
done this way?" Everything else is just work.

## Test: is this a decision?

Capture it if **all three** hold:

1. **There was a real alternative.** Something else would have plausibly worked. "We used
   Postgres" is not a decision if Postgres was never in question.
2. **The reasoning is not visible in the code.** If the code obviously explains itself, the
   code is the record. Capture the reasons that *aren't* in the diff — the benchmark you
   ran, the vendor limit you hit, the bug you're routing around.
3. **It constrains future work.** Someone will later be tempted to undo it. That temptation
   is exactly what the record exists to intercept.

Do **not** capture: naming choices, formatting, anything already written in an ADR or a
ticket, or "we fixed the bug". A record that fires on every commit trains everyone,
including the model, to ignore records.

## What to write

Keep it to five fields. Longer records are less likely to be read and much less likely to
be written at all.

- **Decision** — one sentence, present tense, stating what is now true.
  *"Order IDs are stored as strings, not integers."*
- **Context** — the forcing condition. What made this a question at all?
  *"A payments partner sends IDs like `A-40912`; our importer was dropping ~2% of rows."*
- **Alternatives rejected** — each with the reason it lost. This is the field that stops
  relitigation, and it is the field people skip. Do not skip it.
  *"Numeric ID + a separate external_ref column: rejected, doubles every join in the
  reconciliation path."*
- **Consequences** — what this now costs or forbids. Be honest about the downside; a record
  with no downside listed reads as marketing and gets discounted.
  *"Sorting by ID is no longer chronological. Anything needing insertion order must use
  `created_at`."*
- **Revisit when** — the condition that would make this decision wrong. If you cannot name
  one, the decision may be more provisional than you think.
  *"If the partner ever normalizes to numeric IDs, or if reconciliation joins get hot."*

## Where it goes

Pick the most durable location that the people affected will actually encounter:

| Scope | Put it |
| --- | --- |
| One function or block | A comment directly above the code, starting `Why:` |
| One module or subsystem | `docs/adr/NNN-short-slug.md` in the repo |
| Cross-project or personal practice | A brain memory note, so it follows you across repos |

For anything above function scope, prefer a file in the repo. The brain will observe the
file and index it, so a committed record gets you both durability and recall. A record that
lives *only* in memory is invisible to teammates and to anyone reading the repo on a
different machine.

## Phrasing that survives retrieval

Future recall is keyword-driven, so write for the search that will find this later:

- **Name the concrete things.** Include the file path, the table, the column, the library,
  the error message. "We had encoding problems" retrieves nothing; `UnicodeDecodeError`
  and `importers/partner_feed.py` retrieve reliably.
- **State it as a fact, not as an event.** "IDs are strings" outlives "today we changed IDs
  to strings" — the latter reads as stale the moment it's a month old.
- **Avoid conversational deixis.** No "as discussed", "the approach above", "this one".
  The retriever will show one paragraph with no surrounding conversation.
- **Date anything time-bound.** "Pinned to 2.4.1 (2026-08) pending upstream fix #1182."

## Confirm, don't assume

Before writing, state back the decision in one line and let the user correct it. Capturing
a decision the user didn't actually make is worse than capturing nothing — it will be
recalled with confidence and acted on for months.

Then write it, and say where you put it in one line. No ceremony.
