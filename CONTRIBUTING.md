# Contributing

Thanks for your interest. Before anything else, read the section below — it changes what
"contributing" can mean right now.

## License

Agentic Brain is licensed under the **Apache License 2.0** (see `LICENSE` and `NOTICE`).

## Contributing code

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork, branch, and open a pull request. Run `npm test` (and `npm run test:sandbox` on macOS or
   Linux) before you push; new behaviour needs a test.
3. Sign off every commit (`git commit -s`), which certifies the
   [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or
   have the right to submit it.

**Contributor terms.** By submitting a contribution you agree that:

- it is licensed to the project and its users under the Apache License 2.0; and
- the project owner may also distribute it under other license terms in future versions of
  Agentic Brain (for example, a different license for a later major release). Versions already
  released under Apache 2.0 stay available under Apache 2.0.

If you cannot agree to the second point, say so in your pull request before it is merged.

## Other ways to help

- **File issues.** Bug reports, questions, and design feedback are useful and welcome even
  without a contribution path for code. Use the bug report or feature request templates.
- **Testing counts.** The project has limited real-world usage so far. Trying it, running
  `brain doctor`, and reporting what breaks (see `BETA.md`) is a genuinely valuable contribution.

## Project shape, for context

If you're exploring the code: `bin/brain.mjs` is the CLI entry point, `bin/lib/*.mjs` holds the
engine modules (one concern per file — `wire.mjs` for MCP wiring, `inject.mjs` for context
injection, `dream.mjs` for the wiki, `scrub.mjs` for the secret scrubber, etc.), `evals/*.mjs`
are the test suites (run them all with `npm test`, or one with `node evals/<name>-test.mjs`;
no required dependencies), and `docs/specs/` holds the design specs each subsystem was built
against. `ui/` is the localhost control panel (`server.mjs` + static `app.js`/`index.html`).

## Questions

Open an issue. There's no separate mailing list or chat for this project at this stage.
