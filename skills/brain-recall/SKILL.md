---
name: brain-recall
description: Pull prior context out of the brain's memory before starting work on a task. Trigger when the user says "have we done this before", "what do I know about X", "why is this code like this", "did we already fix this", "check my memory", "what happened last time", or at the start of any non-trivial task in a repo the brain has observations for.
---

# Recalling from the brain

The brain holds observations captured from past sessions across every tool and project.
Most of them are noise for the task in front of you. The job is to spend a small, bounded
amount of effort turning that archive into two or three sentences of usable context — and
then to stop.

## When recall is worth it

Run a recall pass when **any** of these hold:

- The task touches code you did not write in this session.
- The user's phrasing implies history: "again", "still", "back to", "like we did for".
- You are about to make a choice that is hard to reverse (schema, API shape, dependency).
- You hit a failure whose message looks like something a human would have already fought.

Skip recall for: pure-syntax questions, brand-new files, anything the user has fully
specified in the current message. A recall pass that returns nothing costs a round trip;
a recall pass you skipped costs a repeat of last month's mistake.

## The three-query pattern

Do not fire one broad query and give up. Fire up to three, narrowing each time.

1. **Error-or-symptom query.** Search the literal string you are staring at — the exception
   class, the failing assertion, the config key. Verbatim strings match well and this is the
   query most likely to return a directly-applicable past fix.
2. **Component query.** Search the file path, module name, or table name. This surfaces
   *why* the code looks the way it does, which is what you need before changing it.
3. **Intent query.** Search the goal in the user's own words ("rate limit the webhook").
   This is the weakest query and the one most likely to return adjacent-but-wrong results,
   so run it last and weigh its hits lowest.

If queries 1 and 2 both come back empty, stop. There is no memory of this and further
searching is a waste of the user's time and tokens. Say so, briefly, and proceed.

## Reading what comes back

Observations carry a project, a timestamp, and the session they came from. Grade each hit
before you use it:

| Signal | What it means | How to weigh it |
| --- | --- | --- |
| Same project, recent | Almost certainly still true | Act on it |
| Same project, months old | May describe code that has since changed | Verify against the file before acting |
| Different project | A pattern, not a fact | Borrow the approach, never the specifics |
| A `learnings/` entry | Already distilled and human-approved | Highest confidence available |
| A `wiki/` page | Aggregated across many sessions | Good for orientation, thin on detail |

**Always verify before you act.** An observation says what was true when it was captured.
If it says "the retry limit lives in `config/queue.yml`", open the file. If the file
disagrees with memory, the file wins — and that disagreement is itself worth capturing
(see `capture-decision`).

## Reporting recall to the user

Fold what you found into your first substantive reply, attributed and dated:

> From memory (this repo, 3 weeks ago): the ID column was switched to a string because a
> partner sends non-numeric IDs. I'll keep it a string. — checked `models/order.py`, still
> matches.

Two rules:

- **Attribute it.** The user must be able to tell "the brain told me" from "I inferred
  this". Never present recalled context as if you deduced it from the code.
- **Don't dump.** Three relevant sentences beat fifteen retrieved observations. If you
  found six useful hits, use the two that change what you're about to do and drop the rest.

## Failure modes to avoid

- **Recall theatre** — running a search, finding nothing, and narrating the search anyway.
  Silence is the correct output of an empty recall.
- **Stale confidence** — quoting a nine-month-old observation about a fast-moving file as
  present fact.
- **Cross-project bleed** — applying another project's conventions because the search
  ranked them highly. Check the project field on every hit you use.
- **Recalling instead of reading** — memory is a pointer to where to look, not a substitute
  for looking. If the answer is in a file you can open in one call, open it.
