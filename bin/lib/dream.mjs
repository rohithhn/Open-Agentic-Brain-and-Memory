// The self-improving layer ("Dream") — implements Karpathy's "LLM Wiki" pattern
// (gist 442a6bf555914893e9891c11519de94f) over claude-mem's memory:
//
//   Layer 1  raw sources (immutable)  → the claude-mem observations DB
//   Layer 2  the wiki (LLM/tool-owned) → wiki/*.md concept pages + index/log/lint
//   Layer 3  the schema (config)       → wiki/SCHEMA.md (page types + workflows)
//
// The wiki is COMPOUNDING, not regenerative: we never wipe the directory. Each
// dream INGESTS observations newer than the last pass, updates the machine-owned
// region of related pages in place, refreshes cross-references, appends a history
// entry to the log, and runs a LINT pass (contradictions / stale claims / orphans).
// Human-authored regions (below the auto markers) are preserved verbatim forever.
//
// Deterministic (no LLM required): dedupes by content_hash, ranks by
// relevance_count + recency, groups by concept, links by co-occurrence. An LLM
// ingest/query pass (per SCHEMA.md) can be layered on top later.
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { MEMORY_DB, REPO_WIKI, sanitizeName } from './paths.mjs';
import { readScoresPublic } from './learn.mjs';
import { runLifecycle, isForeignStore, liveOnly, autoLifecycleEnabled } from './lifecycle.mjs';

const STOP = new Set([
  'how-it-works', 'what-changed', 'pattern', 'problem-solution', 'gotcha',
  'why-it-exists', 'trade-off', 'decision', 'validation', 'refactor',
  'security_note', 'security-note', 'verification', 'observation', 'summary',
]);

// Reserved page names the concept-ingest never overwrites or treats as concepts.
const RESERVED = new Set(['index', 'briefing', 'log', 'lint', 'schema']);

// Machine-owned region markers. Everything OUTSIDE this block is human-owned and
// preserved across every dream. Everything INSIDE is regenerated each pass.
const AUTO_START = '<!-- brain:auto:start -->';
const AUTO_END = '<!-- brain:auto:end -->';

const DAY = 86400000;
const STALE_DAYS = 60;
const STATE_FILE = '.state.json';

function parseConcepts(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {}
  return [];
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map(String);
  } catch {}
  return [];
}

function esc(s) {
  return String(s ?? '').replace(/\n/g, ' ').trim();
}

function maxEpoch(db) {
  try {
    return db.prepare('SELECT MAX(created_at_epoch) AS m FROM observations').get().m || 0;
  } catch {
    return 0;
  }
}

function isoOf(epoch) {
  // created_at_epoch is milliseconds; new Date(<arg>) is safe (only argless throws in workflows).
  return epoch ? new Date(epoch).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
}

function loadState() {
  const p = join(REPO_WIKI, STATE_FILE);
  if (!existsSync(p)) return { lastEpoch: 0, concepts: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { lastEpoch: 0, concepts: {} };
  }
}

function saveState(state) {
  writeFileSync(join(REPO_WIKI, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Page merge: replace ONLY the machine-owned region; preserve everything else.
// Returns 'created' | 'updated'.
// ---------------------------------------------------------------------------
function writePageMerged(file, title, autoBody) {
  const path = join(REPO_WIKI, file);
  const auto = `${AUTO_START}\n${autoBody}\n${AUTO_END}`;
  if (existsSync(path)) {
    const cur = readFileSync(path, 'utf8');
    const a = cur.indexOf(AUTO_START);
    const b = cur.indexOf(AUTO_END);
    if (a !== -1 && b !== -1 && b > a) {
      const next = cur.slice(0, a) + auto + cur.slice(b + AUTO_END.length);
      if (next !== cur) writeFileSync(path, next);
      return 'updated';
    }
    // Legacy page (pre-marker format, all machine content) — reformat once. There
    // was no human region to lose, so a full rewrite is safe.
  }
  const doc = [
    `# ${title}`,
    '',
    auto,
    '',
    '## Notes',
    '_Human-owned. Anything you write here persists across dreams._',
    '',
  ].join('\n');
  writeFileSync(path, doc);
  return 'created';
}

// Read + dedup + rank observations into concepts, and compute cross-references.
// Shared by dream() and lint() so a standalone lint gets the same concept view.
function analyze(db, topConcepts = 60) {
  const now = maxEpoch(db); // latest observation time (Date.now unavailable in workflows)
  const rows = db
    .prepare(
      // Concept pages are wiki text brain_context injects: deleted rows are out.
      `SELECT project, title, subtitle, facts, concepts, content_hash,
              COALESCE(relevance_count,0) AS rel, created_at, created_at_epoch
       FROM observations o WHERE concepts IS NOT NULL AND concepts != ''${liveOnly(db)}`
    )
    .all();

  // Dedup by content_hash (keep the most-relevant / most-recent copy).
  const byHash = new Map();
  for (const r of rows) {
    const key = r.content_hash || r.title + r.created_at_epoch;
    const prev = byHash.get(key);
    if (!prev || r.rel > prev.rel || r.created_at_epoch > prev.created_at_epoch) byHash.set(key, r);
  }
  const obs = [...byHash.values()];

  // Index observations by concept.
  const concepts = new Map(); // concept -> { count, rel, items[], last }
  for (const o of obs) {
    for (const c of new Set(parseConcepts(o.concepts))) {
      if (STOP.has(c.toLowerCase()) || RESERVED.has(c.toLowerCase())) continue;
      let e = concepts.get(c);
      if (!e) concepts.set(c, (e = { count: 0, rel: 0, items: [], last: 0 }));
      e.count++;
      e.rel += o.rel;
      e.items.push(o);
      if (o.created_at_epoch > e.last) e.last = o.created_at_epoch;
    }
  }

  // Score = frequency + relevance signal; keep the strongest concepts.
  const ranked = [...concepts.entries()]
    .map(([c, e]) => ({ concept: c, ...e, score: e.count + e.rel * 2 }))
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, topConcepts);

  // Cross-references: co-occurrence of ranked concepts within the same observation.
  const rankedSet = new Set(ranked.map((e) => e.concept));
  const co = new Map(); // concept -> Map(other -> shared count)
  const bump = (a, b) => {
    if (!co.has(a)) co.set(a, new Map());
    const m = co.get(a);
    m.set(b, (m.get(b) || 0) + 1);
  };
  for (const o of obs) {
    const cs = [...new Set(parseConcepts(o.concepts))].filter((c) => rankedSet.has(c));
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        bump(cs[i], cs[j]);
        bump(cs[j], cs[i]);
      }
  }
  return { obs, ranked, co, now };
}

// ---------------------------------------------------------------------------
// Main dream: ingest → update pages → cross-reference → index → briefing → log → lint
// ---------------------------------------------------------------------------
export function dream({ topConcepts = 60, perConcept = 12, lifecycle = true, log = () => {} } = {}) {
  if (!existsSync(MEMORY_DB)) throw new Error('No memory DB to dream over.');
  mkdirSync(REPO_WIKI, { recursive: true });
  writeSchemaIfAbsent();

  const db = openDb(MEMORY_DB, { readonly: true });
  const state = loadState();
  const { obs, ranked, co, now } = analyze(db, topConcepts);
  const ingested = obs.filter((o) => (o.created_at_epoch || 0) > (state.lastEpoch || 0)).length;

  const relatedOf = (concept) =>
    [...(co.get(concept) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([other]) => other);

  // Update pages (compounding — machine region only, human Notes preserved).
  let created = 0;
  let updated = 0;
  const nextConcepts = {};
  for (const e of ranked) {
    const items = e.items
      .sort((a, b) => b.rel - a.rel || b.created_at_epoch - a.created_at_epoch)
      .slice(0, perConcept);
    const related = relatedOf(e.concept);
    const file = sanitizeName(e.concept) + '.md';
    const outcome = writePageMerged(file, e.concept, conceptAutoBody(e, items, related));
    if (outcome === 'created') created++;
    else updated++;
    nextConcepts[e.concept] = { count: e.count, rel: e.rel, last: e.last, file };
  }

  const briefing = writeBriefing(db, obs, ranked, now);
  writeFileSync(join(REPO_WIKI, 'index.md'), wikiIndex(ranked, obs.length, now));

  // Lint (Layer-2 health): contradictions / stale claims / orphans / isolated concepts.
  const lintResult = lint({ db, obs, ranked, co, now, log: () => {} });

  // History log (compounding — newest entry prepended).
  appendLog({ now, ingested, created, updated, ranked: ranked.length, lint: lintResult });

  // Persist state for the next incremental pass.
  saveState({ lastEpoch: now, concepts: nextConcepts });

  // Lint's findings become row status (lifecycle.mjs): contradictions →
  // contested, stale concepts → stale, plus newer decision/fix → superseded.
  // Metadata only, reversible, never on claude-mem's own DB.
  const findings = lifecycle ? lintFindings(db, { ranked, now }) : null;
  db.close();
  let lifecycleResult = null;
  if (findings && !isForeignStore(MEMORY_DB) && !autoLifecycleEnabled(MEMORY_DB)) {
    // Not opted in: report only. Nothing is written and no column is added.
    try {
      const r = runLifecycle({ dbPath: MEMORY_DB, apply: false, findings });
      lifecycleResult = { dryRun: true, counts: r.counts, changes: r.changes };
      log(`  lifecycle (dry run): would re-mark ${r.changes} row(s) — review with 'brain lifecycle', enable with 'brain lifecycle --apply'`);
    } catch (e) {
      log('  lifecycle skipped: ' + e.message);
    }
  } else if (findings && !isForeignStore(MEMORY_DB)) {
    try {
      const r = runLifecycle({ dbPath: MEMORY_DB, apply: true, findings, auto: false });
      lifecycleResult = { updated: r.updated, counts: r.counts, current: r.current, backupPath: r.backupPath };
      log(`  lifecycle: ${r.updated} row(s) re-marked · ${r.current.superseded} superseded, ${r.current.contested} contested, ${r.current.stale} stale`);
    } catch (e) {
      log('  lifecycle skipped: ' + e.message);
    }
  }
  log(
    `  dreamed: ${ranked.length} concepts (${created} new, ${updated} updated) · ` +
      `${ingested} new observations ingested · lint: ${lintResult.contradictions} contradictions, ` +
      `${lintResult.stale} stale, ${lintResult.orphans} orphans`
  );
  return {
    concepts: ranked.length,
    created,
    updated,
    ingested,
    observations: obs.length,
    briefing,
    lint: lintResult,
    lifecycle: lifecycleResult,
  };
}

// Lint's findings in full, as lifecycle inputs — the lint.md report shows only
// the top of each list; row status needs all of them. Read-only.
export function lintFindings(db, { ranked, now } = {}) {
  if (!ranked) {
    const a = analyze(db);
    ranked = a.ranked;
    now = now || a.now;
  }
  now = now || maxEpoch(db);
  const contradictions = db
    .prepare(
      `SELECT content_hash FROM observations WHERE content_hash IS NOT NULL AND content_hash != ''
        GROUP BY content_hash HAVING COUNT(DISTINCT project) > 1`
    )
    .all()
    .map((r) => r.content_hash);
  const staleConcepts = ranked.filter((e) => now - (e.last || 0) > STALE_DAYS * DAY).map((e) => e.concept);
  const staleSet = new Set(staleConcepts);
  const liveConcepts = ranked.map((e) => e.concept).filter((c) => !staleSet.has(c));
  return { contradictions, staleConcepts, liveConcepts };
}

function conceptAutoBody(e, items, related) {
  const projects = [...new Set(e.items.map((i) => i.project))];
  const L = [];
  L.push(`> ${e.count} observations across ${projects.length} projects · relevance ${e.rel} · last seen ${isoOf(e.last)}`);
  L.push('');
  L.push(`**Seen in:** ${projects.slice(0, 12).join(', ')}`);
  L.push('');
  L.push('### Key knowledge');
  for (const o of items) {
    const facts = parseList(o.facts).slice(0, 3);
    L.push(`- **${esc(o.title || o.subtitle || 'note')}** _(${esc(o.project)})_`);
    for (const f of facts) L.push(`  - ${esc(f)}`);
  }
  if (related.length) {
    L.push('');
    L.push('### Related');
    L.push(related.map((r) => `[${r}](${encodeURIComponent(sanitizeName(r))}.md)`).join(' · '));
  }
  return L.join('\n');
}

function wikiIndex(ranked, obsCount, now) {
  const L = [];
  L.push('# Knowledge wiki');
  L.push('');
  L.push('_Compounding LLM-wiki over claude-mem memory. Pages update in place; human notes persist._');
  L.push('');
  L.push(`**Data through ${isoOf(now)}** · ${obsCount} deduped observations · ${ranked.length} concepts tracked`);
  L.push('');
  L.push('Meta: [schema](SCHEMA.md) · [briefing](briefing.md) · [lint](lint.md) · [log](log.md)');
  L.push('');
  L.push('| Concept | Observations | Relevance | Score |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const e of ranked) {
    L.push(`| [${e.concept}](${encodeURIComponent(sanitizeName(e.concept))}.md) | ${e.count} | ${e.rel} | ${e.score} |`);
  }
  L.push('');
  return L.join('\n');
}

function writeBriefing(db, obs, ranked, now) {
  const recent = obs.filter((o) => now - o.created_at_epoch < 7 * DAY);
  const byProject = new Map();
  for (const o of recent) byProject.set(o.project, (byProject.get(o.project) || 0) + 1);
  const activeProjects = [...byProject.entries()].sort((a, b) => b[1] - a[1]);

  // Stale: projects with no activity in 30 days.
  const lastByProject = new Map();
  for (const o of obs) {
    const p = o.project;
    if (!lastByProject.has(p) || o.created_at_epoch > lastByProject.get(p))
      lastByProject.set(p, o.created_at_epoch);
  }
  const stale = [...lastByProject.entries()]
    .filter(([, t]) => now - t > 30 * DAY)
    .map(([p, t]) => ({ p, days: Math.round((now - t) / DAY) }))
    .sort((a, b) => b.days - a.days);

  const L = [];
  L.push('# Daily briefing');
  L.push('');
  L.push(`_${recent.length} observations in the last 7 days across ${activeProjects.length} projects._`);
  L.push('');
  L.push('## Where your attention went');
  for (const [p, n] of activeProjects.slice(0, 8)) L.push(`- **${esc(p)}** — ${n} observations`);
  L.push('');
  L.push('## Rising concepts');
  for (const e of ranked.slice(0, 10)) L.push(`- **${esc(e.concept)}** (${e.count})`);
  L.push('');
  if (stale.length) {
    L.push('## Going stale (30+ days quiet)');
    for (const s of stale.slice(0, 8)) L.push(`- ${esc(s.p)} — ${s.days} days`);
    L.push('');
  }
  writeFileSync(join(REPO_WIKI, 'briefing.md'), L.join('\n'));
  return { recent: recent.length, activeProjects: activeProjects.length, stale: stale.length };
}

// ---------------------------------------------------------------------------
// LINT — the wiki health check. Turns raw signals into actionable reconciliation
// tasks, written to wiki/lint.md. (Karpathy: "the contradictions have already
// been flagged.")
// ---------------------------------------------------------------------------
export function lint({ db: dbIn, ranked: rankedIn, co: coIn, now: nowIn, log = () => {} } = {}) {
  if (!existsSync(MEMORY_DB)) throw new Error('No memory DB to lint over.');
  const ownDb = !dbIn;
  const db = dbIn || openDb(MEMORY_DB, { readonly: true });
  // Standalone lint (no shared analysis passed in): compute the concept view itself
  // so orphan / stale / isolated detection is meaningful.
  if (!rankedIn || !coIn) {
    const a = analyze(db);
    rankedIn = a.ranked;
    coIn = a.co;
    nowIn = nowIn || a.now;
  }
  const now = nowIn || maxEpoch(db);

  // Contradictions: identical content recorded under >1 project (same as home's
  // "conflicts" signal) — candidates for a human to reconcile.
  const contradictions = db
    .prepare(
      `SELECT content_hash, GROUP_CONCAT(DISTINCT project) AS projects, COUNT(*) n
         FROM observations WHERE content_hash IS NOT NULL AND content_hash != ''
        GROUP BY content_hash HAVING COUNT(DISTINCT project) > 1
        ORDER BY n DESC LIMIT 25`
    )
    .all();

  // Stale claims: ranked concepts whose newest observation is > STALE_DAYS old.
  const staleClaims = (rankedIn || [])
    .filter((e) => now - (e.last || 0) > STALE_DAYS * DAY)
    .map((e) => ({ concept: e.concept, days: Math.round((now - (e.last || 0)) / DAY) }))
    .sort((a, b) => b.days - a.days);

  // Orphan pages: concept pages on disk no longer surfaced in the ranked index
  // (dropped below threshold). Compounding keeps the page; lint flags it for review.
  const rankedNames = new Set((rankedIn || []).map((e) => sanitizeName(e.concept) + '.md'));
  const orphanPages = existsSync(REPO_WIKI)
    ? readdirSync(REPO_WIKI).filter(
        (f) =>
          f.endsWith('.md') &&
          !RESERVED.has(f.replace(/\.md$/, '').toLowerCase()) &&
          !rankedNames.has(f)
      )
    : [];

  // Isolated concepts: ranked concepts with no cross-references (no co-occurrence)
  // — knowledge islands worth linking by hand.
  const isolated = coIn
    ? (rankedIn || []).filter((e) => !(coIn.get(e.concept) && coIn.get(e.concept).size)).map((e) => e.concept)
    : [];

  const L = [];
  L.push('# Wiki lint');
  L.push('');
  L.push(`_Health check, data through ${isoOf(now)}. Actionable reconciliation — not auto-applied._`);
  L.push('');

  L.push(`## Contradictions to reconcile (${contradictions.length})`);
  L.push('_Same content recorded under multiple projects. Confirm which is canonical._');
  if (contradictions.length)
    for (const c of contradictions) L.push(`- \`${(c.content_hash || '').slice(0, 10)}\` — in **${c.projects}** (${c.n}×)`);
  else L.push('- none');
  L.push('');

  L.push(`## Stale claims (${staleClaims.length})`);
  L.push(`_Concepts with no new observation in ${STALE_DAYS}+ days. Re-verify or archive._`);
  if (staleClaims.length)
    for (const s of staleClaims.slice(0, 20)) L.push(`- [${s.concept}](${encodeURIComponent(sanitizeName(s.concept))}.md) — ${s.days} days`);
  else L.push('- none');
  L.push('');

  L.push(`## Orphan pages (${orphanPages.length})`);
  L.push('_Pages no longer surfaced in the index. Merge into a live concept or archive._');
  if (orphanPages.length) for (const f of orphanPages.slice(0, 30)) L.push(`- [${f.replace(/\.md$/, '')}](${encodeURIComponent(f)})`);
  else L.push('- none');
  L.push('');

  L.push(`## Isolated concepts (${isolated.length})`);
  L.push('_No cross-references to other concepts. Consider linking by hand._');
  if (isolated.length) for (const c of isolated.slice(0, 30)) L.push(`- [${c}](${encodeURIComponent(sanitizeName(c))}.md)`);
  else L.push('- none');
  L.push('');

  // Never-helpful learnings: injected enough times but net-negative/zero feedback.
  const scores = readScoresPublic();
  const neverHelpful = Object.entries(scores).filter(([, e]) => (e.used||0) >= 5 && (e.helped||0) <= 0);
  L.push(`## Never-helpful learnings (${neverHelpful.length})`);
  L.push('_Injected ≥5× with net-zero/negative feedback. Consider archiving._');
  if (neverHelpful.length) for (const [f, e] of neverHelpful) L.push(`- \`${f}\` — used ${e.used}, helped ${e.helped}`);
  else L.push('- none');
  L.push('');

  mkdirSync(REPO_WIKI, { recursive: true });
  writeFileSync(join(REPO_WIKI, 'lint.md'), L.join('\n'));
  if (ownDb) db.close();

  const result = {
    contradictions: contradictions.length,
    stale: staleClaims.length,
    orphans: orphanPages.length,
    isolated: isolated.length,
  };
  log(`  lint: ${result.contradictions} contradictions, ${result.stale} stale, ${result.orphans} orphans, ${result.isolated} isolated`);
  return result;
}

// ---------------------------------------------------------------------------
// History log — one entry per dream, newest first. Compounding record.
// ---------------------------------------------------------------------------
function appendLog({ now, ingested, created, updated, ranked, lint }) {
  const path = join(REPO_WIKI, 'log.md');
  const header = '# Dream log\n\n_Append-only history of dream passes (newest first)._\n';
  const entry =
    `## ${isoOf(now)}\n` +
    `- ingested: ${ingested} new observations\n` +
    `- pages: ${created} created, ${updated} updated\n` +
    `- concepts tracked: ${ranked}\n` +
    `- lint: ${lint.contradictions} contradictions · ${lint.stale} stale · ${lint.orphans} orphans · ${lint.isolated} isolated\n`;
  let body = header + '\n' + entry + '\n';
  if (existsSync(path)) {
    const cur = readFileSync(path, 'utf8');
    const prior = cur.startsWith(header) ? cur.slice(header.length).replace(/^\n+/, '') : cur;
    body = header + '\n' + entry + '\n' + prior;
  }
  writeFileSync(path, body);
}

// ---------------------------------------------------------------------------
// Layer 3 — the schema. Seeded once; never overwritten (human-editable config).
// ---------------------------------------------------------------------------
function writeSchemaIfAbsent() {
  const path = join(REPO_WIKI, 'SCHEMA.md');
  if (existsSync(path)) return;
  writeFileSync(path, SCHEMA_TEMPLATE);
}

const SCHEMA_TEMPLATE = `# Wiki schema

_This wiki follows Andrej Karpathy's "LLM Wiki" pattern: a persistent, compounding
knowledge base an LLM/tool maintains between you and your raw sources, instead of
re-deriving answers from scratch on every query._

## Three layers

1. **Raw sources (immutable)** — the claude-mem observations DB (\`~/.claude-mem/claude-mem.db\`),
   plus ingested Codex/Antigravity sessions. Never edited here; only read.
2. **The wiki (this folder, tool-owned)** — markdown pages of distilled knowledge.
3. **The schema (this file)** — structure + workflows. Human-editable; \`dream\` never overwrites it.

## Page types

- **Concept pages** (\`<concept>.md\`) — one per tracked concept. Two regions:
  - A machine-owned block between \`${AUTO_START}\` and \`${AUTO_END}\`, rewritten every dream.
  - A \`## Notes\` region (and anything outside the markers) that is **human-owned and preserved forever**.
- **index.md** — ranked table of concepts + links to meta pages.
- **briefing.md** — recent attention, rising concepts, stale projects.
- **lint.md** — health check: contradictions, stale claims, orphan pages, isolated concepts.
- **log.md** — append-only history of dream passes.
- **.state.json** — bookkeeping (last ingested epoch, per-concept stats). Not a page.

## Workflows

- **Ingest** (\`brain dream\`) — read observations newer than the last pass, refresh the
  machine region of related concept pages, recompute cross-references, update index/briefing,
  append a log entry. Compounding: pages and human notes are never wiped.
- **Query** — search memory for a task; fold matching pages + past learnings into the prompt.
  Valuable answers can be filed back into a page's \`## Notes\` region (\`fileNote\`).
- **Lint** — flag contradictions/stale/orphans for a human to reconcile. Never auto-applies.

## Rules

- Edit freely below the \`${AUTO_START}\`/\`${AUTO_END}\` markers — your edits survive every dream.
- Do not hand-edit inside the markers; those lines are regenerated.
- Encrypted at rest in the brain blob; gitignored in plaintext.
`;

// ---------------------------------------------------------------------------
// Query file-back — append a bullet to a page's human-owned Notes region,
// creating the page if needed. Completes the LLM-wiki "query files results back" op.
// ---------------------------------------------------------------------------
export function fileNote(topic, note) {
  if (!topic || !note) throw new Error('fileNote needs topic + note');
  mkdirSync(REPO_WIKI, { recursive: true });
  const file = sanitizeName(topic) + '.md';
  const path = join(REPO_WIKI, file);
  const bullet = `- ${esc(note)} _(filed ${isoOf(maxEpochSafe())})_`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# ${topic}\n\n${AUTO_START}\n_No distilled observations yet._\n${AUTO_END}\n\n## Notes\n_Human-owned. Anything you write here persists across dreams._\n\n${bullet}\n`
    );
    return { file, created: true };
  }
  const cur = readFileSync(path, 'utf8');
  // Append to the human-owned Notes region (create it if the page predates markers).
  const next = cur.includes('## Notes')
    ? cur.trimEnd() + `\n${bullet}\n`
    : cur.trimEnd() + `\n\n## Notes\n${bullet}\n`;
  writeFileSync(path, next);
  return { file, created: false };
}

function maxEpochSafe() {
  if (!existsSync(MEMORY_DB)) return 0;
  const db = openDb(MEMORY_DB, { readonly: true });
  try {
    return maxEpoch(db);
  } finally {
    db.close();
  }
}

// Extract the machine-owned (distilled) region of a page for injection.
function autoRegion(txt) {
  const a = txt.indexOf(AUTO_START);
  const b = txt.indexOf(AUTO_END);
  if (a !== -1 && b !== -1 && b > a) return txt.slice(a + AUTO_START.length, b).trim();
  return txt.replace(/^#.*$/m, '').trim(); // legacy page: drop the title, keep the body
}

// Find the wiki concept pages most relevant to a task — the SYNTHESIZED knowledge
// (cross-referenced, deduped) to inject into an agent prompt, in preference to the
// raw observation firehose. Concept-name matches are weighted higher than body hits.
export function searchWiki(task, limit = 2) {
  if (!existsSync(REPO_WIKI) || !task) return [];
  const words = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return [];
  const scored = [];
  for (const f of readdirSync(REPO_WIKI).filter((x) => x.endsWith('.md'))) {
    const name = f.replace(/\.md$/, '');
    if (RESERVED.has(name.toLowerCase())) continue;
    const txt = readFileSync(join(REPO_WIKI, f), 'utf8');
    const hay = txt.toLowerCase();
    const nameLc = name.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLc.includes(w)) score += 3;
      if (hay.includes(w)) score += 1;
    }
    if (score > 0) scored.push({ name, score, txt });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ topic: x.name, content: autoRegion(x.txt) }));
}

export function listWiki() {
  if (!existsSync(REPO_WIKI)) return [];
  return readdirSync(REPO_WIKI)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

// Wiki pages with metadata for the Dream table (page · size · last updated),
// newest first. Includes one level of subfolders (e.g. workflows/*).
export function listWikiMeta() {
  if (!existsSync(REPO_WIKI)) return [];
  const out = [];
  for (const entry of readdirSync(REPO_WIKI, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(REPO_WIKI, entry.name);
      for (const f of readdirSync(sub).filter((x) => x.endsWith('.md'))) {
        const st = statSync(join(sub, f));
        out.push({ name: `${entry.name}/${f.replace(/\.md$/, '')}`, section: entry.name, bytes: st.size, updated: st.mtime.toISOString() });
      }
    } else if (entry.name.endsWith('.md')) {
      const st = statSync(join(REPO_WIKI, entry.name));
      out.push({ name: entry.name.replace(/\.md$/, ''), section: 'page', bytes: st.size, updated: st.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function readWiki(topic) {
  const p = join(REPO_WIKI, sanitizeName(topic) + '.md');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}
