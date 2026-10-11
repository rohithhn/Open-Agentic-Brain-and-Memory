---
name: onboard-codebase
description: Build a working mental model of an unfamiliar repository fast. Trigger when the user says "help me understand this codebase", "I'm new to this repo", "where do I start", "how does this project work", "where does X live", "explain the architecture", or when you are asked to change code in a repo you have no prior context for.
---

# Orienting in an unfamiliar repo

The goal is not to understand the whole codebase — you never will and you don't need to.
The goal is to answer three questions well enough to make a safe change: **how does this
run, where does a request or command flow, and what will yell at me if I break it?**

## Step 0 — Ask the brain what it already knows

Before reading anything, search memory for the repo name and for the directory you're in.
If this project has been worked on before, past observations, decision records, and wiki
pages give you in one step what file-reading takes twenty calls to reconstruct — including
the things files never say, like which module is a minefield and which abstraction was
abandoned halfway.

Treat what comes back as a map, not as ground truth: verify anything you're about to act on
against the current files, since the code may have moved since it was observed.

## Step 1 — The manifest and the entry point (5 minutes)

Read, in this order:

1. **The package/build manifest** — `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `pom.xml`. It tells you the language version, the frameworks (so you already know 60% of
   the conventions), and — most usefully — the **scripts**. `dev`, `build`, `test`, `lint`,
   `migrate` are the project's own description of how it is operated.
2. **The entry point** the scripts name. `main`, `index`, `app`, `cmd/*/main.go`, the
   `console_scripts` target. Follow it until you reach the first branch into application
   code, then stop. You now know how the thing starts.
3. **README, and only the setup section.** Skim the rest. Ignore anything that contradicts
   the manifest — the manifest is executable and therefore true; the README is prose and
   frequently a year old.

## Step 2 — Shape before detail

Get the layout in two commands rather than by opening files:

- List directories two levels deep. Directory names are the architecture: `handlers/` +
  `services/` + `repositories/` is layered; `billing/` + `auth/` + `search/` is
  feature-sliced; `packages/*` is a monorepo and you need to find which package matters
  before anything else.
- Count lines per directory. The three biggest non-vendor directories are where the
  system's real work happens, and where you'll spend your time.

Also note what's *conspicuously absent*: no tests directory, no migrations, no CI config —
each absence tells you something about how the project is actually maintained.

## Step 3 — Trace one path end to end

This is the step that produces real understanding, and the one people skip in favour of
reading more files.

Pick **one** concrete operation — ideally the one your task touches, otherwise the most
central one you can identify (login, create the main entity, the primary CLI command).
Follow it all the way: entry point → route or dispatch → handler → business logic → data
access → response. Read only what's on that path.

Along the way, write down (for yourself, or for the user):

- **The main data type** and where it's defined. Most codebases have one or two central
  nouns; find them and much of the rest becomes predictable.
- **How dependencies arrive** — constructor injection, a global container, imports at module
  top, framework magic. This determines how you'll test anything you write.
- **Where the boundaries are** — where does it hit the database, the network, the disk?
  Those are the places changes get risky.
- **Error and logging convention** — exceptions, result types, error returns? Copy whatever
  is there rather than introducing a second pattern.

One traced path teaches more than fifty skimmed files, because it shows you the conventions
in motion rather than in isolation.

## Step 4 — Find the guardrails

Before changing anything, learn what will tell you if you're wrong:

- **Run the test suite once, unchanged.** You need to know its baseline — how long it takes,
  and whether it's already red. Discovering a pre-existing failure *after* your edit costs
  an hour of misattributed debugging.
- **Read the CI config.** It is the authoritative list of what must pass: lint rules,
  type-checking, coverage floors, formatters. Whatever CI runs is the real definition of
  "done" in this repo.
- **Read one existing test** near the code you'll change. It shows you the expected test
  style, the fixture helpers, and how the team stands up dependencies.
- **Check for hooks and generated files** — `.githooks/`, `pre-commit`, codegen steps. Editing
  a generated file is a classic newcomer hour-waster; a generated file usually says so at
  the top.

## Step 5 — Read the history where it's confusing

When a piece of code looks wrong or arbitrary, `git log -p` on that file, or `git blame` on
the specific line, usually explains it in one commit message. Look especially for a commit
that *added* something odd-looking with a message referencing an incident or a bug number —
that's a landmine marked by the person who stepped on it.

If nothing explains it, say so explicitly rather than guessing at the reason.

## Step 6 — Write down what you learned

Capture the orientation while it's fresh, so the next session in this repo starts from
step 3 instead of step 1: the entry point, the traced path, the central data types, the
build/test commands, and the two or three surprises. Surprises are the highest-value part —
"the `utils` package imports from `api`, so import order matters", "tests need Docker
running", "`config.yaml` is generated, edit `config.template.yaml`".

## What to tell the user

Lead with the shape, not an inventory:

> Layered Express app. Requests go `routes/` → `controllers/` → `services/` → `db/` (Knex,
> raw SQL in `db/queries/`). The central type is `Account` in `models/account.ts`. Tests
> are Jest and need a local Postgres — `npm run test:setup` first. Two surprises: `utils/`
> imports from `services/` in three places, and `schema.sql` is generated from the
> migrations.

Then say what you're still unsure about. Naming your gaps is more useful than a confident
summary that quietly papers over the part you didn't read.
