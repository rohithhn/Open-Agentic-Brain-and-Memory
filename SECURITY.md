# Security

This document describes the threat model in plain terms: what encryption here actually
protects, what it does not, and how to report a problem privately. Read it before trusting
this tool with anything sensitive.

## What is encrypted, and what that protects against

Your memory — observations, the compounding wiki, distilled learnings, and exports — is packed
into a tarball and encrypted with [`age`](https://github.com/FiloSottile/age) before it ever
leaves your machine. The encrypted blob is what gets uploaded, as a GitHub Release asset on
**your own private repo**. The `age` identity (private key) is generated on your machine and
kept in the OS secret store (see "Where the key is stored" below). This tool never commits it
in plaintext and never transmits it. `brain key backup` commits a copy encrypted with a
passphrase you choose, so that a new machine can recover the key.

This means:

- **A leaked repo, a leaked GitHub token, or a compromised GitHub account exposes nothing
  readable.** Whoever gets the blob gets ciphertext. Without the `age` identity (or the
  recovery passphrase, if you made a key backup), it does not decrypt.
- **The confidentiality boundary is entirely the `age` key.** Anyone who has both the encrypted
  blob and the key has everything, in full — there is no second factor and no partial-access
  mode. Guard the key like a password manager master password (see `BETA.md` for how to back
  it up — the same property that makes leaking it catastrophic makes losing it unrecoverable).
- **Skills, agents, and settings sync in plaintext**, not encrypted, by design — they're meant
  to be portable and inspectable, and settings are redacted (tokens/keys masked) before they're
  ever written to the repo. Treat your skills/agents repo content as visible to anyone with repo
  access, because it is.
- **Repo privacy is a second, independent control**, not a substitute for encryption. The data
  repo `brain init` creates is set private, and the tool refuses to proceed if it detects the
  repo is public. But encryption is what protects you if that control ever fails (misconfigured
  repo, accidental collaborator invite, GitHub incident) — that is deliberate defense in depth,
  not redundant caution.

## Where the key is stored

- **macOS:** the Keychain.
- **Linux:** the desktop keyring through libsecret (`secret-tool`, with GNOME Keyring or
  KWallet) when one is available. Without a keyring, the key falls back to an encrypted file,
  `~/.claude-brain/secrets.enc` (mode 0600). That file's encryption key is derived from the
  machine-id (or hostname), your uid and your username, which anything on the machine can read.
  So the fallback only protects against casual copying of the file (into a backup, onto
  another machine); it does **not** protect against anyone or anything that can read your
  files. Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora) and use a keyring.

## What is *not* protected

- **Your local machine.** While you're using it, memory sits decrypted in a local SQLite
  database (`~/.claude-brain/brain.db`) and in decrypted working copies
  (`wiki/`, `learnings/`, `memory/exports/`). Anyone with access to your logged-in account has
  the same access this tool does. This project adds no local-disk encryption beyond what your
  OS provides (for example FileVault on macOS or LUKS on Linux).
- **Anything you type into an AI coding session that a provider's own systems log.** This
  project captures what already happened in your sessions; it doesn't change what the model
  provider (Anthropic, OpenAI, Google, etc.) does with your prompts on their end.
- **A compromised machine.** If your machine is compromised while you're logged in, the key is
  reachable by anything running as you. This is the same trust boundary as every other tool
  that uses the OS keychain or keyring.

## The secret scrubber is best-effort — not a guarantee

Observations are captured from your real coding sessions, which means they can contain
whatever was in your terminal at the time: API keys pasted for debugging, tokens in error
output, credentials in a config file you `cat`'d. `brain scrub` runs pattern- and
entropy-based detectors over captured text to find and redact likely secrets before they
persist.

**State this plainly: the scrubber is a best-effort filter, not a guarantee of a clean corpus.**
It is tuned for precision over free text, which means it will miss some things — an unusual
credential format, a secret embedded in prose without the usual prefixes, anything that doesn't
match a known pattern or trip the entropy heuristic. A detected secret being scrubbed from
the *local database* also does not "un-leak" a credential that was already valid and exposed
elsewhere — rotate any secret you know landed in a session, regardless of whether the scrubber
caught it.

To check what the scrubber has and hasn't found in your own memory:

```bash
node bin/brain.mjs scrub --audit
```

This is read-only by default and reports what it detects without changing anything. Review the
findings, then run `node bin/brain.mjs scrub --apply --yes` if you want it to redact what it
found (this takes a backup first and is reversible via `scrub --revert`). Treat an empty audit
result as "nothing this filter's patterns catch," not as "definitely nothing sensitive in
there."

## Reporting a vulnerability

This is a small open-source project — there is no security team, no bug bounty, and no SLA.
If you find a vulnerability (a way to read the encrypted blob without the key, a way for one
user's wiring to leak into another's, a flaw in the scrubber's detection logic that matters for
confidentiality, etc.):

- **Report it privately**, not as a public GitHub issue. Preferred: GitHub private
  vulnerability reporting — on this repository's **Security** tab, click
  **"Report a vulnerability"**. If you can't use that, email **agenticbrain@zohomail.in**.
- Include what you found, how to reproduce it, and what you think the impact is. You do not
  need to include a full exploit — a clear description is enough to start with.
- Please do not test against anyone else's data or repo without their explicit permission —
  each user's private repo and key are their own.

There is no disclosed timeline commitment beyond "the maintainer will respond" — this is
honest about the maturity of the project, not a policy statement designed to sound more solid
than it is.
