#!/usr/bin/env node
// graph.mjs: the knowledge graph reads the brain's own store, so a new user who
// never had claude-mem still gets a graph.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../bin/lib/store.mjs';
import { buildGraph, searchGraphConcepts } from '../bin/lib/graph.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const dir = mkdtempSync(join(tmpdir(), 'graph-test-'));
try {
  const dbPath = join(dir, 'brain.db');
  const db = openStore({ path: dbPath });
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, concepts, created_at, created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?,?,?)`);
  const rows = [
    ['bakery-app', ['sqlite', 'offline-first', 'order-queue']],
    ['bakery-app', ['sqlite', 'order-queue', 'pricing']],
    ['bakery-app', ['sqlite', 'offline-first', 'order-queue']],
    ['bakery-app', ['sqlite', 'offline-first', 'order-queue', 'decision']],
    ['receipts', ['printer', 'pricing']],
    ['receipts', ['printer', 'pricing']],
  ];
  rows.forEach(([p, c], i) => ins.run(`m-${i}`, p, 'discovery', `t${i}`, 'n', JSON.stringify(c), '2026-10-01', i, `h${i}`));
  db.close();

  t('builds from the native store: projects, concepts, and related-concept edges', () => {
    const g = buildGraph({ dbPath });
    assert(g.stats.projects === 2, `projects: ${g.stats.projects}`);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const id of ['p:bakery-app', 'p:receipts', 'c:sqlite', 'c:order-queue', 'c:printer', 'c:pricing']) assert(ids.has(id), `missing ${id}`);
    assert(!ids.has('c:decision'), 'taxonomy tags are hidden');
    assert(g.edges.some((e) => e.kind === 'related' && [e.source, e.target].sort().join() === 'c:order-queue,c:sqlite'), 'co-occurring concepts are linked');
    assert(g.nodes.find((n) => n.id === 'c:printer').group === 'receipts', 'concept grouped under its main project');
  });
  t('every node carries its newest memory time (ms) for recency', () => {
    const g = buildGraph({ dbPath });
    const by = (id) => g.nodes.find((n) => n.id === id);
    assert(by('p:bakery-app').last === 3, `bakery last: ${by('p:bakery-app').last}`);
    assert(by('p:receipts').last === 5, `receipts last: ${by('p:receipts').last}`);
    assert(by('c:printer').last === 5 && by('c:offline-first').last === 3, 'concept last = newest row carrying it');
  });
  t('soft-deleted memories drop out of the graph (counts match the Memory tab)', () => {
    const w = openStore({ path: dbPath });
    w.prepare(`UPDATE observations SET status = 'deleted' WHERE project = 'receipts'`).run();
    w.close();
    const g = buildGraph({ dbPath });
    assert(!g.nodes.some((n) => n.id === 'p:receipts' || n.id === 'c:printer'), 'deleted rows hidden');
    assert(g.nodes.find((n) => n.id === 'c:sqlite').weight === 4, 'live rows still counted');
  });
  // A big-brain shape: many projects, a long tail of concepts the overview cannot show.
  const bigPath = join(dir, 'big.db');
  const bdb = openStore({ path: bigPath });
  const bins = bdb.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, concepts, created_at, created_at_epoch, content_hash) VALUES (?,?,?,?,?,?,?,?,?)`);
  let k = 0;
  const add = (p, cs) => { bins.run(`b-${k}`, p, 'discovery', `t${k}`, 'n', cs == null ? null : JSON.stringify(cs), '2026-10-01', k, `bh${k}`); k++; };
  for (let i = 0; i < 30; i++) add('core', ['shared-a', 'shared-b', `core-${i % 10}`]); // dominates the global top
  for (let p = 0; p < 12; p++) for (let i = 0; i < 4; i++) add(`side-${p}`, [`side-${p}-x`, `side-${p}-y`, i < 2 ? 'rare-gem' : `side-${p}-z${i}`]);
  for (let p = 0; p < 12; p++) add(`side-${p}`, ['shared-a']); // a small project touching a big shared concept once
  add('no-concepts', null); add('no-concepts', []);
  bdb.close();

  t('every project is a hub, even with no concepts or none in the global top', () => {
    const g = buildGraph({ dbPath: bigPath, topConcepts: 5, perProject: 0 });
    const hubs = g.nodes.filter((n) => n.type === 'project').map((n) => n.label);
    assert(hubs.length === 14 && hubs.includes('no-concepts') && hubs.includes('side-11'), hubs.join());
    assert(g.stats.concepts === 5 && g.stats.totalConcepts > 40, JSON.stringify(g.stats));
    assert(g.nodes.find((n) => n.id === 'p:no-concepts').weight === 2, 'hub weight counts every live memory');
  });
  t('overview gives each project its own top concept (perProject) so no hub is bare', () => {
    const g = buildGraph({ dbPath: bigPath, topConcepts: 5, perProject: 1 });
    for (let p = 0; p < 12; p++) assert(g.edges.some((e) => e.source === `p:side-${p}`), `side-${p} has a satellite`);
    assert(g.stats.concepts > 5, 'guaranteed concepts are added on top of the global top');
  });
  t('every hub with concepts is linked, even when a bigger project owns its shared concepts', () => {
    const g = buildGraph({ dbPath: bigPath, topConcepts: 3, perProject: 0 });
    const sources = new Set(g.edges.filter((e) => e.kind === 'has').map((e) => e.source));
    for (let p = 0; p < 12; p++) assert(sources.has(`p:side-${p}`), `side-${p} is linked`);
    assert(g.edges.some((e) => e.source === 'p:side-9' && e.target === 'c:rare-gem' && e.weight === 2), 'linked to its strongest shown concept, past the 8-spoke cap');
  });
  t('limit raises how many topics are shown', () => {
    const a = buildGraph({ dbPath: bigPath, topConcepts: 5, perProject: 0 }), b = buildGraph({ dbPath: bigPath, topConcepts: 20, perProject: 0 });
    assert(b.stats.concepts === 20 && a.stats.concepts === 5, `${a.stats.concepts} -> ${b.stats.concepts}`);
  });
  t('project mode returns that project\'s own top concepts, not just the global ones', () => {
    const g = buildGraph({ dbPath: bigPath, project: 'side-3', topConcepts: 36 });
    assert(g.focus === 'p:side-3', `focus ${g.focus}`);
    const cs = g.nodes.filter((n) => n.type === 'concept').map((n) => n.label).sort();
    assert(cs.includes('side-3-x') && cs.includes('side-3-z2') && cs.includes('rare-gem') && !cs.includes('core-1'), cs.join());
    assert(g.edges.some((e) => e.source === 'p:side-3' && e.target === 'c:side-3-x' && e.weight === 4), 'hub link carries the in-project weight');
    assert(g.edges.some((e) => e.kind === 'related'), 'in-project co-occurrence links');
    assert(buildGraph({ dbPath: bigPath, project: 'nope' }).focus === null, 'unknown project: no focus');
    assert(Array.isArray(g.recent) && g.recent.length === 5 && g.recent.every((r) => r.project === 'side-3' && r.id && r.title), 'recent: newest 5 titled memories');
    assert(g.recent[0].title === 't' + (Math.max(...g.recent.map((r) => Number(r.title.slice(1))))), 'newest first');
  });
  t('concept mode returns any concept in the store plus its neighbours', () => {
    const g = buildGraph({ dbPath: bigPath, concept: 'side-7-y', neighbors: 5 });
    assert(g.focus === 'c:side-7-y', `focus ${g.focus}`);
    const ids = new Set(g.nodes.map((n) => n.id));
    assert(ids.has('c:side-7-y') && ids.has('c:side-7-x') && ids.has('p:side-7'), [...ids].join());
    assert(g.edges.some((e) => e.kind === 'related' && [e.source, e.target].includes('c:side-7-y')), 'linked to neighbours');
    assert(g.nodes.find((n) => n.id === 'c:rare-gem').projects === 12, 'concept says how many projects use it');
  });
  t('concept search finds any concept in the store, exact and prefix first', () => {
    const r = searchGraphConcepts('side-1', { dbPath: bigPath, limit: 50 });
    assert(r.length > 3 && r.every((x) => x.concept.includes('side-1')), JSON.stringify(r.slice(0, 3)));
    assert(searchGraphConcepts('rare-gem', { dbPath: bigPath })[0].concept === 'rare-gem', 'exact first');
    assert(searchGraphConcepts('', { dbPath: bigPath }).length === 0 && searchGraphConcepts('zzz', { dbPath: bigPath }).length === 0, 'empty/no match');
  });
  t('a missing store is an empty graph with stats, not a crash', () => {
    const g = buildGraph({ dbPath: join(dir, 'none.db') });
    assert(g.nodes.length === 0 && g.stats && g.stats.projects === 0, JSON.stringify(g));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
