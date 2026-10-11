// Cross-platform skill availability.
//
// A skill written once should be callable from any CLI or app the user works
// in. Every tool here happens to agree on the same on-disk contract —
// <root>/<skill-name>/SKILL.md with `name:` and `description:` frontmatter — so
// no translation is needed; they just look in different roots.
//
// We link rather than copy. A symlink per skill means a skill edited once is
// current everywhere immediately, and it leaves each tool's own skills (Codex's
// `.system`, Cursor's local ones) untouched. Copies were the previous approach
// on this machine and had already drifted a month out of date.
//
// Nothing is ever deleted. A target entry we did not create is reported and
// stepped over, never replaced, unless --relink is passed explicitly.
import { existsSync, readdirSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

// Where a skill library might live, best first. `~/.claude/skills` is normally
// a symlink into `~/.claude-shared/skills`; resolve it so links point at the
// real directory rather than a link to a link.
const LIBRARY_CANDIDATES = [
  join(HOME, '.claude-shared', 'skills'),
  join(HOME, '.claude', 'skills'),
  join(HOME, '.claude-personal', 'skills'),
];

export const SKILL_TARGETS = [
  { id: 'claude',  name: 'Claude Code',        dir: join(HOME, '.claude', 'skills') },
  { id: 'codex',   name: 'Codex CLI / app',    dir: join(HOME, '.codex', 'skills') },
  { id: 'cursor',  name: 'Cursor',             dir: join(HOME, '.cursor', 'skills') },
  { id: 'agy',     name: 'Antigravity (agy)',  dir: join(HOME, '.agents', 'skills') },
];

// Entries that are the tool's own business, not skills to mirror.
const RESERVED = (n) => n.startsWith('.') || n === 'node_modules';

export function resolveLibrary() {
  for (const c of LIBRARY_CANDIDATES) {
    if (!existsSync(c)) continue;
    try { return resolve(statSync(c).isDirectory() ? realish(c) : c); } catch { return c; }
  }
  return null;
}

// Follow a symlinked directory one level to its real path.
function realish(p) {
  try { return lstatSync(p).isSymbolicLink() ? resolve(readlinkSync(p)) : p; } catch { return p; }
}

export function listSkills(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !RESERVED(e.name))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

// Read `name:` / `description:` out of a SKILL.md without a YAML dependency.
// Only the two fields every tool agrees on; anything else is left to the tool.
export function readSkillMeta(libDir, skill) {
  const f = join(libDir, skill, 'SKILL.md');
  if (!existsSync(f)) return { name: skill, description: '', hasSkillMd: false };
  let head = '';
  try { head = readFileSync(f, 'utf8').slice(0, 4000); } catch { return { name: skill, description: '', hasSkillMd: false }; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const body = fm ? fm[1] : '';
  const field = (k) => {
    // Handles `k: value`, `k: "value"`, and folded `k: >` / `k: |` blocks.
    const re = new RegExp(`^${k}:[ \\t]*(?:([>|])\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)|(.*))$`, 'm');
    const m = re.exec(body);
    if (!m) return '';
    const v = m[1] ? m[2].split('\n').map((s) => s.trim()).join(' ') : (m[3] || '');
    return v.trim().replace(/^["']|["']$/g, '');
  };
  return { name: field('name') || skill, description: field('description'), hasSkillMd: true };
}

// Classify what currently sits at target/<skill>.
function inspect(targetDir, skill, libDir) {
  const p = join(targetDir, skill);
  let st;
  try { st = lstatSync(p); } catch { return { state: 'missing', path: p }; }
  if (st.isSymbolicLink()) {
    let dest = '';
    try { dest = resolve(readlinkSync(p)); } catch {}
    return { state: dest === resolve(join(libDir, skill)) ? 'linked' : 'foreign-link', path: p, dest };
  }
  return { state: 'own-copy', path: p };
}

/**
 * Mirror the skill library into every tool that can read skills from disk.
 * Dry-run unless `apply`. `relink` additionally replaces stale real-directory
 * copies with links, moving the original aside first — never deleting.
 */
export function syncSkills({ apply = false, relink = false, targets = SKILL_TARGETS, log = () => {} } = {}) {
  const libDir = resolveLibrary();
  if (!libDir) return { ok: false, error: 'no skill library found', libDir: null, targets: [] };

  const skills = listSkills(libDir);
  const out = { ok: true, libDir, skillCount: skills.length, targets: [], linked: 0, relinked: 0, skipped: 0 };

  for (const t of targets) {
    const isLibrary = resolve(realish(t.dir)) === resolve(libDir);
    const row = { id: t.id, name: t.name, dir: t.dir, isLibrary, linked: 0, already: 0, ownCopies: [], foreign: 0, created: false };

    if (isLibrary) { row.note = 'this IS the library — nothing to mirror'; row.already = skills.length; out.targets.push(row); continue; }

    if (!existsSync(t.dir)) {
      row.created = true;
      if (apply) mkdirSync(t.dir, { recursive: true });
    }

    for (const s of skills) {
      const info = inspect(t.dir, s, libDir);
      if (info.state === 'linked') { row.already++; continue; }
      if (info.state === 'foreign-link') { row.foreign++; continue; }
      if (info.state === 'own-copy') {
        row.ownCopies.push(s);
        if (!relink) { out.skipped++; continue; }
        if (apply) {
          // Move aside with a suffix rather than delete: the copy may have
          // local edits this machine never pushed to the library.
          renameSync(info.path, `${info.path}.replaced-by-brain`);
          symlinkSync(join(libDir, s), info.path);
        }
        row.linked++; out.relinked++; continue;
      }
      if (apply) {
        try { symlinkSync(join(libDir, s), info.path); }
        catch (e) { if (e.code !== 'EEXIST') { row.error = e.message; continue; } }
      }
      row.linked++; out.linked++;
    }
    out.targets.push(row);
    log(`  ${t.name}: ${row.linked} to link, ${row.already} already, ${row.ownCopies.length} own copies${row.foreign ? `, ${row.foreign} foreign links` : ''}`);
  }
  return out;
}

export function skillsStatus() {
  const libDir = resolveLibrary();
  const skills = libDir ? listSkills(libDir) : [];
  return {
    libDir,
    total: skills.length,
    targets: SKILL_TARGETS.map((t) => {
      const present = skills.filter((s) => existsSync(join(t.dir, s))).length;
      return {
        id: t.id, name: t.name, dir: t.dir,
        exists: existsSync(t.dir),
        present, missing: skills.length - present,
        isLibrary: resolve(realish(t.dir)) === resolve(libDir || ''),
      };
    }),
  };
}
