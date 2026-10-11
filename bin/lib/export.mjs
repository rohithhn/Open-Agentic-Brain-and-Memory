// Export claude-mem.db into readable, deterministic, mergeable files under
// memory/exports/<project>/. JSONL is the sync currency (dedup by natural key);
// README.md per project is the human/AI-readable "wiki" digest.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, count, tableExists } from './db.mjs';
import { MEMORY_DB, REPO_EXPORTS, REPO_MEMORY, sanitizeName } from './paths.mjs';
import { findSecrets } from './scrub.mjs';
import { LIFECYCLE_COLUMN_NAMES } from './store.mjs';

// Empty-shaped result for a brand-new / not-yet-populated brain, so callers
// (doSync, POST /api/sync) degrade gracefully instead of throwing.
function emptyExportResult() {
  return { totals: { sessions: 0, observations: 0, summaries: 0, prompts: 0, projects: 0 }, perProject: [] };
}

// Same pattern as preExportSweep: tolerate a missing table rather than throw —
// a brand-new claude-mem DB, or one mid-migration, may not have every table yet.
function selectAll(db, table, orderBy) {
  if (!tableExists(db, table)) return [];
  try {
    return db.prepare(`SELECT * FROM ${table}${orderBy ? ` ORDER BY ${orderBy}` : ''}`).all();
  } catch {
    return [];
  }
}

// P7 (docs/specs/secret-scrubber.md §5.3): pre-export gate, defence in depth.
// Nothing unscrubbed should ever reach memory/exports/** or the encrypted blob.
// This is read-only (findSecrets, not scrubText) — it does not mutate the DB; a
// Tier-1 hit here means P1-P6 (capture-time scrubbing) missed something and the
// export must fail loudly rather than silently ship a secret.
const SCRUB_SCOPE = [
  { table: 'observations', cols: ['text', 'narrative', 'facts', 'title', 'subtitle', 'metadata'] },
  { table: 'user_prompts', cols: ['prompt_text'] },
  { table: 'session_summaries', cols: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] },
  { table: 'sdk_sessions', cols: ['user_prompt'] },
];

export function preExportSweep(db, { log = () => {} } = {}) {
  const hits = [];
  for (const { table, cols } of SCRUB_SCOPE) {
    let existingCols;
    try {
      existingCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    } catch { continue; }
    const useCols = cols.filter((c) => existingCols.has(c));
    if (!useCols.length) continue;
    let rows;
    try { rows = db.prepare(`SELECT id, ${useCols.join(', ')} FROM ${table}`).all(); } catch { continue; }
    for (const row of rows) {
      for (const col of useCols) {
        const val = row[col];
        if (typeof val !== 'string' || !val) continue;
        for (const h of findSecrets(val, { tiers: [1, 2, 3, 4], entropyMode: 'off' })) {
          hits.push({ table, id: row.id, column: col, detector: h.detector, tier: h.tier });
        }
      }
    }
  }
  const tier1 = hits.filter((h) => h.tier <= 2);
  if (tier1.length) {
    log(`  ⚠️  pre-export sweep found ${tier1.length} unscrubbed Tier 1/2 secret(s) — capture-time scrubbing missed them.`);
    for (const h of tier1.slice(0, 20)) log(`      ${h.table}#${h.id}.${h.column} → ${h.detector}`);
  }
  return { hits, tier1Count: tier1.length };
}

// Stable stringify: sorted keys → identical bytes for identical data → clean diffs.
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(obj[k] ?? null));
  return '{' + parts.join(',') + '}';
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map(stableStringify).join('\n') + (rows.length ? '\n' : ''));
}

export function runExport({ log = () => {}, skipScrubGate = false } = {}) {
  if (!existsSync(MEMORY_DB)) {
    log('  ⚠️  no memory DB yet — writing an empty export (brain has not captured anything).');
    // Still write empty-but-valid export dir + index so downstream steps (sync,
    // UI) find a consistent shape rather than "exports missing" ambiguity.
    if (existsSync(REPO_EXPORTS)) rmSync(REPO_EXPORTS, { recursive: true, force: true });
    mkdirSync(REPO_EXPORTS, { recursive: true });
    const empty = emptyExportResult();
    writeFileSync(join(REPO_MEMORY, 'index.md'), memoryIndex(empty.perProject, empty.totals));
    return empty;
  }

  const db = openDb(MEMORY_DB, { readonly: true });

  if (!skipScrubGate) {
    const sweep = preExportSweep(db, { log });
    if (sweep.tier1Count > 0) {
      db.close();
      throw new Error(
        `Pre-export scrub gate: ${sweep.tier1Count} unscrubbed Tier 1/2 secret(s) found in the DB. ` +
          `Run "brain scrub --audit" for details, then "brain scrub --apply" before exporting/syncing.`
      );
    }
  }

  const sessions = selectAll(db, 'sdk_sessions', 'memory_session_id');
  const observations = selectAll(db, 'observations', 'project, memory_session_id, content_hash, id');
  const summaries = selectAll(db, 'session_summaries', 'project, memory_session_id, prompt_number, id');
  const prompts = selectAll(db, 'user_prompts', 'content_session_id, prompt_number, id');
  if (!tableExists(db, 'sdk_sessions') && !tableExists(db, 'observations')) {
    log('  ⚠️  memory DB exists but has none of claude-mem\'s tables yet — exporting empty.');
  }

  // Map content_session_id -> project (for prompts, which lack a project column).
  const projByContentSession = new Map();
  for (const s of sessions) projByContentSession.set(s.content_session_id, s.project);

  const byProject = new Map();
  const bucket = (proj) => {
    const key = proj || '_default';
    if (!byProject.has(key)) {
      byProject.set(key, { sessions: [], observations: [], summaries: [], prompts: [] });
    }
    return byProject.get(key);
  };

  for (const s of sessions) bucket(s.project).sessions.push(s);
  // Lifecycle columns are local bookkeeping (superseded_by is a LOCAL row id):
  // kept out of the sync currency so exports stay stable and another machine
  // never inherits ids that point at the wrong rows (store.mjs).
  for (const o of observations) {
    for (const c of LIFECYCLE_COLUMN_NAMES) delete o[c];
    bucket(o.project).observations.push(o);
  }
  for (const su of summaries) bucket(su.project).summaries.push(su);
  for (const p of prompts) bucket(projByContentSession.get(p.content_session_id)).prompts.push(p);

  // Rebuild the exports dir cleanly (source of truth is always the DB).
  if (existsSync(REPO_EXPORTS)) rmSync(REPO_EXPORTS, { recursive: true, force: true });
  mkdirSync(REPO_EXPORTS, { recursive: true });

  const summary = [];
  for (const [project, data] of [...byProject.entries()].sort()) {
    const dir = join(REPO_EXPORTS, sanitizeName(project));
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, 'sessions.jsonl'), data.sessions);
    writeJsonl(join(dir, 'observations.jsonl'), data.observations);
    writeJsonl(join(dir, 'summaries.jsonl'), data.summaries);
    writeJsonl(join(dir, 'prompts.jsonl'), data.prompts);
    writeFileSync(join(dir, 'README.md'), projectDigest(project, data));
    summary.push({
      project,
      sessions: data.sessions.length,
      observations: data.observations.length,
      summaries: data.summaries.length,
      prompts: data.prompts.length,
    });
    log(`  exported ${project}: ${data.observations.length} obs, ${data.summaries.length} summaries`);
  }

  const totals = {
    sessions: count(db, 'sdk_sessions'),
    observations: count(db, 'observations'),
    summaries: count(db, 'session_summaries'),
    prompts: count(db, 'user_prompts'),
    projects: byProject.size,
  };

  writeFileSync(join(REPO_MEMORY, 'index.md'), memoryIndex(summary, totals));
  db.close();
  return { totals, perProject: summary };
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function projectDigest(project, data) {
  const recent = [...data.observations]
    .sort((a, b) => (b.created_at_epoch || 0) - (a.created_at_epoch || 0))
    .slice(0, 40);
  const lines = [];
  lines.push(`# ${project}`);
  lines.push('');
  lines.push(
    `**${data.observations.length}** observations · **${data.summaries.length}** summaries · ` +
      `**${data.sessions.length}** sessions · **${data.prompts.length}** prompts`
  );
  lines.push('');
  lines.push('## Most recent observations');
  lines.push('');
  lines.push('| When | Type | Title |');
  lines.push('| --- | --- | --- |');
  for (const o of recent) {
    lines.push(`| ${esc(o.created_at)} | ${esc(o.type)} | ${esc(o.title || o.subtitle || '')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function memoryIndex(summary, totals) {
  const lines = [];
  lines.push('# Memory index');
  lines.push('');
  lines.push(
    `Total: **${totals.observations}** observations · **${totals.summaries}** summaries · ` +
      `**${totals.prompts}** prompts across **${totals.projects}** projects.`
  );
  lines.push('');
  lines.push('| Project | Observations | Summaries | Sessions | Prompts |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const s of [...summary].sort((a, b) => b.observations - a.observations)) {
    lines.push(
      `| ${esc(s.project)} | ${s.observations} | ${s.summaries} | ${s.sessions} | ${s.prompts} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}
