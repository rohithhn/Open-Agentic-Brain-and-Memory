// Test-fixture projects: sessions that are some harness's throwaway runs, not
// the operator's work. They come from end-to-end suites (another app's, or a
// harness that forgot its temp HOME) that drive a real `claude -p` / `codex exec`
// inside a generated working dir; capture files the session under that dir's
// basename, and the brain then carries dozens of one-row "projects" that pollute
// dream lint, the digest and the project list.
//
// Matching is by project name only, against an EXPLICIT list of shapes no person
// names a project by hand. Deliberately conservative: a name that merely looks
// test-ish ("tmp", "beta", "components", "real-claude-test") is never matched —
// those stay for the operator to judge. Add a pattern here only with the
// generator it comes from.
//
// Two strengths:
//   auto: true  — never captured at all: ingest, the claude-mem pull, the cloud
//                 merge and the exports merge all leave these projects out.
//   auto: false — `brain clean --test-data` finds them (the dry run lists each
//                 by name), but capture keeps them: a bare UUID is a plausible
//                 name for a real working dir, and silently never capturing it
//                 would be a loss nobody sees. Once the operator removes one with
//                 --apply, its name is recorded (CLEANED_TABLE) and from then on
//                 it is skipped exactly like an auto pattern, so the next sync
//                 cannot merge it straight back.
export const TEST_DATA_PATTERNS = [
  { id: 'e2e-probe', auto: true, re: /^e2e-probe-\d+$/,
    why: 'numbered e2e probe dirs (e2e-probe-001…)' },
  { id: 'proj-run-context', auto: true, re: /^proj-run-context(?:-(?:inherited|existing|project-only))?-\d{10,}$/,
    why: 'run-context fixtures suffixed with a ms timestamp' },
  { id: 'od-fixture', auto: true, re: /^od-(?:conn-test-[A-Za-z0-9]+|accept-[a-z0-9-]+|code-(?:fresh|entry-demo)|a11y-target)$/,
    why: 'od-* acceptance / connection-test fixture dirs' },
  { id: 'uuid-dir', auto: false, re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    why: 'a bare UUID working dir (generated per run; clean-only — capture keeps it until you remove it)' },
];

// The pattern id a project name matches (any strength), or null. This is what
// `brain clean --test-data` reports and removes.
export function testDataPattern(project) {
  if (typeof project !== 'string' || !project) return null;
  for (const p of TEST_DATA_PATTERNS) if (p.re.test(project)) return p.id;
  return null;
}

export function isTestDataProject(project) {
  return testDataPattern(project) !== null;
}

// Only the auto patterns: projects capture never takes in.
export function isAutoTestDataProject(project) {
  if (typeof project !== 'string' || !project) return false;
  return TEST_DATA_PATTERNS.some((p) => p.auto && p.re.test(project));
}

// ── projects the operator already removed ────────────────────────────────────
// A small table in the store itself, so it travels with the DB (the cloud blob
// is a snapshot of the whole store) and survives restarts. Created lazily by
// `brain clean --test-data --apply`; absent everywhere else, which reads as
// "nothing removed yet".
export const CLEANED_TABLE = 'test_data_cleaned';

// Read-only: the set of project names `clean --test-data --apply` removed from
// this DB. Never throws (a missing table or an unreadable DB is an empty set).
export function readCleanedProjects(db) {
  try {
    const t = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(CLEANED_TABLE);
    if (!t) return new Set();
    return new Set(db.prepare(`SELECT project FROM ${CLEANED_TABLE}`).all().map((r) => r.project));
  } catch { return new Set(); }
}

// Record removed project names (inside the caller's write connection).
export function recordCleanedProjects(db, entries, { now = new Date().toISOString() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${CLEANED_TABLE} (
    project TEXT PRIMARY KEY, pattern TEXT, cleaned_at TEXT)`);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${CLEANED_TABLE} (project, pattern, cleaned_at) VALUES (?,?,?)`);
  let n = 0;
  for (const { project, pattern } of entries) if (project) n += ins.run(project, pattern || null, now).changes;
  return n;
}

// The capture-time test: an auto pattern, or a project already removed here.
// `cleaned` is one Set or several (e.g. the destination's and the source's).
export function captureSkipper(...cleaned) {
  const sets = cleaned.filter((s) => s && s.size);
  return (project) => isAutoTestDataProject(project) || sets.some((s) => s.has(project));
}
