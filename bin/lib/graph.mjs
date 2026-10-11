// Build a knowledge graph from the memory DB: projects and concepts as nodes,
// weighted by how often they occur and co-occur. This is what the OS graph view
// renders — a live map of what your brain actually knows.
import { existsSync, statSync } from 'node:fs';
import { openDb, tableExists } from './db.mjs';
import { liveOnly } from './lifecycle.mjs';
import { MEMORY_DB } from './paths.mjs';

// claude-mem's fixed observation-taxonomy tags — generic, so we hide them from
// the graph to let real domain concepts surface.
const STOP = new Set([
  'how-it-works', 'what-changed', 'pattern', 'problem-solution', 'gotcha',
  'why-it-exists', 'trade-off', 'decision', 'validation', 'refactor',
  'security_note', 'security-note', 'verification', 'observation', 'summary',
]);

function parseConcepts(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    // fall back to comma/space separated
    return String(raw)
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// Same shape as the populated return below — callers (ui/app.js's Graph tab)
// destructure `stats.projects/concepts/edges` unconditionally, so an empty
// return missing `stats` throws a TypeError that leaves the tab blank forever.
function emptyGraph() {
  return { nodes: [], edges: [], projects: [], stats: { projects: 0, concepts: 0, totalConcepts: 0, edges: 0, memories: 0 } };
}

const SEP = String.fromCharCode(1); // separator absent from names
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// One pass over the live store, cached until the DB (or its WAL) changes: a big
// store (tens of thousands of memories) is scanned once, and every overview /
// project / concept / search request after that is a cheap in-memory query.
let SCAN = null; // { key, data }
function scanKey(dbPath) {
  const m = (f) => { try { const s = statSync(f); return s.mtimeMs + ':' + s.size; } catch { return '-'; } };
  return dbPath + '|' + m(dbPath) + '|' + m(dbPath + '-wal');
}
function scan(dbPath) {
  const key = scanKey(dbPath);
  if (SCAN && SCAN.key === key) return SCAN.data;
  const db = openDb(dbPath, { readonly: true });
  let rows, totals;
  try {
    if (!tableExists(db, 'observations')) return null;
    const live = liveOnly(db);
    // Every project with a live memory is a hub, even one whose memories carry no concepts.
    totals = db.prepare(`SELECT o.project, COUNT(*) AS n, MAX(o.created_at_epoch) AS last FROM observations o WHERE 1=1${live} GROUP BY o.project`).all();
    // Soft-deleted / merged rows are hidden, so the counts here match what
    // the Memory tab shows when you click through from a node.
    rows = db.prepare(`SELECT o.project, o.concepts, o.created_at_epoch AS ep FROM observations o
         WHERE o.concepts IS NOT NULL AND o.concepts != ''${live}`).all();
  } finally {
    db.close();
  }
  const projectCount = new Map(); // project -> live memories
  const projectLast = new Map();
  for (const t of totals) {
    const p = t.project || '_default';
    projectCount.set(p, (projectCount.get(p) || 0) + t.n);
    projectLast.set(p, Math.max(projectLast.get(p) || 0, Number(t.last) || 0));
  }
  const conceptCount = new Map(); // concept -> count
  const conceptLast = new Map(); // concept -> newest created_at_epoch (ms)
  const projConcept = new Map(); // "project<SEP>concept" -> weight
  const list = []; // [project, [concepts]] per row, for co-occurrence on demand
  for (const r of rows) {
    const project = r.project || '_default';
    const ep = Number(r.ep) || 0;
    const cs = [...new Set(parseConcepts(r.concepts))].filter((c) => !STOP.has(c.toLowerCase()));
    if (!cs.length) continue;
    for (const c of cs) {
      conceptCount.set(c, (conceptCount.get(c) || 0) + 1);
      if (ep > (conceptLast.get(c) || 0)) conceptLast.set(c, ep);
      const pk = project + SEP + c;
      projConcept.set(pk, (projConcept.get(pk) || 0) + 1);
    }
    list.push([project, cs]);
  }
  // Per concept: its projects by weight (first = dominant, used to group/color).
  const conceptProjects = new Map();
  for (const [k, w] of projConcept) {
    const sp = k.indexOf(SEP);
    const p = k.slice(0, sp), c = k.slice(sp + 1);
    if (!conceptProjects.has(c)) conceptProjects.set(c, []);
    conceptProjects.get(c).push([p, w]);
  }
  for (const a of conceptProjects.values()) a.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const byCount = [...conceptCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const data = { projectCount, projectLast, conceptCount, conceptLast, projConcept, conceptProjects, byCount, list, memories: [...projectCount.values()].reduce((a, b) => a + b, 0) };
  SCAN = { key, data };
  return data;
}

// Co-occurrence counts among a kept set (only pairs inside it: cheap even on a big store).
function pairsAmong(S, kept, rowFilter) {
  const pair = new Map();
  for (const [p, cs] of S.list) {
    if (rowFilter && !rowFilter(p, cs)) continue;
    const k = cs.filter((c) => kept.has(c));
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) {
      const [a, b] = k[i] < k[j] ? [k[i], k[j]] : [k[j], k[i]];
      const key = a + SEP + b;
      pair.set(key, (pair.get(key) || 0) + 1);
    }
  }
  return pair;
}

function assemble(S, kept, { minRelated = 3, pairs, focusProject = null, focusConcept = null }) {
  const projectList = [...S.projectCount.keys()].sort();
  const nodes = [];
  for (const p of projectList) {
    nodes.push({ id: 'p:' + p, label: p, type: 'project', weight: S.projectCount.get(p), group: p, last: S.projectLast.get(p) || 0 });
  }
  for (const c of kept) {
    const ps = S.conceptProjects.get(c) || [];
    nodes.push({
      id: 'c:' + c, label: c, type: 'concept', weight: S.conceptCount.get(c) || 0,
      group: (ps[0] && ps[0][0]) || '_default',
      last: S.conceptLast.get(c) || 0, // newest memory carrying it (ms), for recency
      projects: ps.length, // how many projects use it (the hub links shown may be fewer)
    });
  }
  // Hub links: a concept's dominant project always, others when they matter
  // (2+ memories), capped so a concept used by 60 projects is not a 60-spoke star.
  const has = [];
  for (const c of kept) {
    const ps = S.conceptProjects.get(c) || [];
    ps.forEach(([p, w], i) => {
      if (i === 0 || p === focusProject || (w >= 2 && i < 8)) has.push({ source: 'p:' + p, target: 'c:' + c, weight: w, kind: 'has' });
    });
  }
  // Every hub gets at least one link (to its strongest shown concept), so no
  // project floats alone just because a big project dominates a shared concept.
  const linked = new Set(has.map((e) => e.source));
  const bestOf = new Map();
  for (const c of kept) for (const [p, w] of S.conceptProjects.get(c) || []) {
    const b = bestOf.get(p); if (!b || w > b[1]) bestOf.set(p, [c, w]);
  }
  for (const [p, [c, w]] of bestOf) if (!linked.has('p:' + p)) has.push({ source: 'p:' + p, target: 'c:' + c, weight: w, kind: 'has' });
  const rel = [];
  for (const [k, w] of pairs) {
    const [a, b] = k.split(SEP);
    if (w < minRelated && a !== focusConcept && b !== focusConcept) continue;
    rel.push({ source: 'c:' + a, target: 'c:' + b, weight: w, kind: 'related' });
  }
  rel.sort((x, y) => y.weight - x.weight);
  const edges = has.concat(rel.slice(0, Math.max(60, kept.size * 3)));
  return {
    nodes,
    edges,
    projects: projectList,
    stats: {
      projects: projectList.length,
      concepts: kept.size,
      totalConcepts: S.conceptCount.size,
      edges: edges.length,
      memories: S.memories,
    },
  };
}

// MEMORY_DB, not claude-mem's DB: a new user who never had claude-mem has only
// the native store, and reading claude-mem's path left their graph empty forever.
//
// Modes (all return the same shape, with stable ids so the UI can merge them):
//   overview   the global top `topConcepts` concepts, plus each project's own
//              top `perProject` (so no hub is left bare), and EVERY project hub
//   project    { project }: that project's own top `topConcepts` concepts
//   concept    { concept }: one concept plus its `neighbors` strongest co-occurring concepts
export function buildGraph({ dbPath = MEMORY_DB, topConcepts = 140, minConceptCount = 2, perProject = 1, project = null, concept = null, neighbors = 12 } = {}) {
  if (!dbPath || !existsSync(dbPath)) return emptyGraph();
  const S = scan(dbPath);
  if (!S || !S.projectCount.size) return emptyGraph();
  topConcepts = clampInt(topConcepts, 1, 1000, 140);

  if (concept) {
    if (!S.conceptCount.has(concept)) return { ...assemble(S, new Set(), { pairs: new Map() }), focus: null };
    const co = new Map();
    for (const [, cs] of S.list) if (cs.includes(concept)) for (const c of cs) if (c !== concept) co.set(c, (co.get(c) || 0) + 1);
    const top = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, clampInt(neighbors, 0, 60, 12)).map(([c]) => c);
    const kept = new Set([concept, ...top]);
    return { ...assemble(S, kept, { pairs: pairsAmong(S, kept), focusConcept: concept }), focus: 'c:' + concept };
  }

  if (project) {
    if (!S.projectCount.has(project)) return { ...assemble(S, new Set(), { pairs: new Map() }), focus: null };
    const mine = [];
    for (const [c, ps] of S.conceptProjects) { const hit = ps.find(([p]) => p === project); if (hit) mine.push([c, hit[1]]); }
    mine.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const kept = new Set(mine.slice(0, topConcepts).map(([c]) => c));
    // co-occurrence inside this project's memories, so the cluster has its own shape
    const pairs = pairsAmong(S, kept, (p) => p === project);
    return { ...assemble(S, kept, { pairs, minRelated: 2, focusProject: project }), focus: 'p:' + project, recent: recentMemories(dbPath, project) };
  }

  const kept = new Set(S.byCount.filter(([, n]) => n >= minConceptCount).slice(0, topConcepts).map(([c]) => c));
  if (perProject > 0) {
    const best = new Map(); // project -> [[concept, w]] top few
    for (const [k, w] of S.projConcept) {
      if (w < minConceptCount) continue;
      const sp = k.indexOf(SEP), p = k.slice(0, sp), c = k.slice(sp + 1);
      const a = best.get(p) || []; a.push([c, w]); best.set(p, a);
    }
    // each project's own strongest concepts that the global list does not already show
    const top = new Set(kept);
    for (const a of best.values()) a.filter(([c]) => !top.has(c)).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, perProject).forEach(([c]) => kept.add(c));
  }
  return assemble(S, kept, { pairs: pairsAmong(S, kept) });
}

// A project's newest live memories (id + title), for the graph's side panel.
function recentMemories(dbPath, project, limit = 5) {
  const db = openDb(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT o.id, o.project, o.title, o.created_at FROM observations o
      WHERE o.project = ? AND o.title IS NOT NULL AND o.title != ''${liveOnly(db)} ORDER BY o.created_at_epoch DESC LIMIT ?`).all(project, limit);
  } finally {
    db.close();
  }
}

// Find any concept in the store by substring (not only the ones on screen).
export function searchGraphConcepts(q, { dbPath = MEMORY_DB, limit = 12 } = {}) {
  q = String(q || '').trim().toLowerCase();
  if (!q || !dbPath || !existsSync(dbPath)) return [];
  const S = scan(dbPath);
  if (!S) return [];
  const out = [];
  for (const [c, n] of S.byCount) {
    const lc = c.toLowerCase();
    if (lc.includes(q)) out.push({ concept: c, count: n, exact: lc === q, prefix: lc.startsWith(q), project: (S.conceptProjects.get(c)?.[0] || [])[0] || null });
  }
  out.sort((a, b) => b.exact - a.exact || b.prefix - a.prefix || b.count - a.count);
  return out.slice(0, clampInt(limit, 1, 50, 12)).map(({ concept, count, project }) => ({ concept, count, project }));
}
