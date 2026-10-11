// Back up the skills that live OUTSIDE the shared library.
//
// `assets.mjs` mirrors ~/.claude-shared/skills — the library you own and edit.
// But two other populations of skills exist on this machine and were never in
// the brain at all:
//
//   plugins   ~/.claude-personal/plugins/cache/<marketplace>/<plugin>/<ver>/skills/
//   projects  <some repo>/.claude/skills/
//
// These are copied into `skills-external/` in the repo, NOT into the shared
// library. That distinction is the whole point: a plugin skill copied into the
// library would shadow the marketplace's own copy and go stale the moment the
// plugin updates, and a project skill hoisted to global scope would start
// firing in every unrelated repo. Backed up, versioned and restorable — but
// still owned by whoever owned it before.
import {
  mkdirSync,
  cpSync,
  readdirSync,
  existsSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT, config } from './paths.mjs';

export const REPO_EXTERNAL = join(REPO_ROOT, 'skills-external');
const PLUGIN_CACHE = join(homedir(), '.claude-personal', 'plugins', 'cache');

// Where to look for project-local skills. Overridable via config.json:
//   "externalSkills": { "projectRoots": ["~/code", "~/work"], "exclude": ["scratch"] }
const DEFAULT_PROJECT_ROOTS = [join(homedir(), 'Documents'), join(homedir(), 'Desktop')];

function cfg() {
  const c = (config && config.externalSkills) || {};
  const roots = Array.isArray(c.projectRoots) && c.projectRoots.length
    ? c.projectRoots.map((p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p))
    : DEFAULT_PROJECT_ROOTS;
  return { roots, exclude: Array.isArray(c.exclude) ? c.exclude : [] };
}

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// A directory is a skill if it declares itself one. Anything else in a skills/
// folder is support material, not a skill.
function isSkill(dir) {
  return existsSync(join(dir, 'SKILL.md'));
}

// Newest-first semver-ish compare. The plugin cache keeps every version ever
// installed (figma alone has four); only the newest is worth backing up, and
// string sort gets 2.2.107 vs 2.2.96 wrong.
function newestVersion(versions) {
  return versions
    .slice()
    .sort((a, b) => {
      const pa = a.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : n));
      const pb = b.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : n));
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x === y) continue;
        return typeof x === 'number' && typeof y === 'number' ? y - x : String(y).localeCompare(String(x));
      }
      return 0;
    })[0];
}

/** Every plugin skill on this machine, newest installed version only. */
export function discoverPluginSkills() {
  const out = [];
  for (const marketplace of dirs(PLUGIN_CACHE)) {
    const mPath = join(PLUGIN_CACHE, marketplace);
    for (const plugin of dirs(mPath)) {
      const versions = dirs(join(mPath, plugin));
      if (!versions.length) continue;
      const version = newestVersion(versions);
      const skillsDir = join(mPath, plugin, version, 'skills');
      for (const skill of dirs(skillsDir)) {
        const dir = join(skillsDir, skill);
        if (isSkill(dir)) out.push({ marketplace, plugin, version, skill, dir });
      }
    }
  }
  return out;
}

/**
 * Every project-local skill under the configured roots.
 *
 * Walks a bounded depth rather than the whole disk — a full ~/Documents scan on
 * a machine with node_modules everywhere takes minutes and finds nothing extra.
 */
export function discoverProjectSkills({ maxDepth = 4 } = {}) {
  const { roots, exclude } = cfg();
  const out = [];
  const seen = new Set();

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    // Found a project? Record its skills and stop descending — a repo's
    // .claude/skills is the answer, its node_modules is not.
    const skillsDir = join(dir, '.claude', 'skills');
    if (existsSync(skillsDir)) {
      const project = basename(dir);
      for (const skill of dirs(skillsDir)) {
        const d = join(skillsDir, skill);
        if (!isSkill(d)) continue;
        // Two checkouts of the same repo ("my-app" and "my-app copy")
        // hold identical skills; keep the first and skip the duplicate.
        const key = `${project}/${skill}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ project, skill, dir: d, projectPath: dir });
      }
    }
    for (const name of dirs(dir)) {
      if (name === 'node_modules' || exclude.includes(name)) continue;
      let sub;
      try {
        sub = join(dir, name);
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(sub, depth + 1);
    }
  };

  for (const r of roots) if (existsSync(r)) walk(r, 0);
  return out;
}

// Copy one skill tree, minus the things that must never travel: dependency
// trees (reproducible from the lockfile), caches, and .env files — a real
// OPENAI_API_KEY was found sitting in one of these on this machine, and this
// destination is a git repo with a remote.
const NEVER_COPY = new Set(['node_modules', '__pycache__', '.git', '.DS_Store', '.venv']);
function copySkill(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => {
      const b = basename(src);
      if (NEVER_COPY.has(b)) return false;
      if (b === '.env' || b.startsWith('.env.')) return b === '.env.example';
      return !b.endsWith('.pyc');
    },
  });
}

/**
 * PUSH: plugin + project skills → repo/skills-external/
 *
 * Mirror semantics, not additive: a skill deleted from a project should leave
 * the backup too, or the tree silently accumulates every skill you ever had.
 * The library mirror in assets.mjs is additive because you own those; these you
 * merely observe.
 */
export function pushExternalSkills({ log = () => {} } = {}) {
  const plugins = discoverPluginSkills();
  const projects = discoverProjectSkills();

  rmSync(REPO_EXTERNAL, { recursive: true, force: true });
  mkdirSync(REPO_EXTERNAL, { recursive: true });

  for (const p of plugins) {
    copySkill(p.dir, join(REPO_EXTERNAL, 'plugins', p.marketplace, p.plugin, p.skill));
  }
  for (const p of projects) {
    copySkill(p.dir, join(REPO_EXTERNAL, 'projects', p.project, p.skill));
  }

  // A manifest, so a restore (or a human) can tell where each copy came from
  // and which plugin version it was taken at.
  const manifest = {
    generated: new Date().toISOString(),
    note:
      'Backup only. These skills are owned by their plugin marketplace or their project ' +
      'and are deliberately NOT copied into ~/.claude-shared/skills — doing so would ' +
      'shadow the original and go stale on update.',
    plugins: plugins.map(({ marketplace, plugin, version, skill }) => ({ marketplace, plugin, version, skill })),
    projects: projects.map(({ project, skill, projectPath }) => ({ project, skill, source: projectPath })),
  };
  writeFileSync(join(REPO_EXTERNAL, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  log(`  backed up ${plugins.length} plugin + ${projects.length} project skill(s) → skills-external/`);
  return { plugins: plugins.length, projects: projects.length };
}

export function externalSkillCounts() {
  const countUnder = (sub) => {
    const root = join(REPO_EXTERNAL, sub);
    let n = 0;
    const walk = (d) => {
      for (const name of dirs(d)) {
        const p = join(d, name);
        if (isSkill(p)) n++;
        else walk(p);
      }
    };
    if (existsSync(root)) walk(root);
    return n;
  };
  return { plugins: countUnder('plugins'), projects: countUnder('projects') };
}
