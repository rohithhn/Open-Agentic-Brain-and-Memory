// Imported FIRST by every eval: marks this process (and every child that
// inherits its env) as a test run, so bin/lib/testguard.mjs refuses any
// write-mode open of the operator's real ~/.claude-brain / ~/.claude-mem store.
// ESM evaluates imports in order, so this runs before paths.mjs resolves a path.
process.env.BRAIN_TEST = '1';
