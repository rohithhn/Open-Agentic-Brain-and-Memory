#!/usr/bin/env node
// Headless UI check for memory curation in the control panel: a real Chrome
// (headless, throwaway profile, mock keychain) drives the real page served by
// ui/server.mjs against a synthetic store in a fake HOME, clicking the same
// buttons a user would — open a memory, pin it, edit it, delete it, Undo.
//
//   node evals/curate-ui-test.mjs            (SKIPs cleanly when Chrome is absent)
//   BRAIN_TEST_CHROME=/path/to/chrome node evals/curate-ui-test.mjs
//   CURATE_UI_SHOTS=/some/dir …              (also saves screenshots there)
//
// CDP over Node's built-in WebSocket; no npm dependency.
import './test-env.mjs'; // BRAIN_TEST=1: never write the real store
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../bin/lib/store.mjs';

const CHROME = [
  process.env.BRAIN_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!CHROME || typeof WebSocket !== 'function') {
  console.log('curate-ui-test: SKIP (no Chrome/Chromium or no global WebSocket)');
  process.exit(0);
}

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = join(process.env.SCRATCHPAD || tmpdir(), `curate-ui-test-${process.pid}`);
const HOME = join(ROOT, 'home');
mkdirSync(join(HOME, '.claude-brain'), { recursive: true });
const DB = join(HOME, '.claude-brain', 'brain.db');
{
  const db = openStore({ path: DB });
  const mem = 'curate:ui';
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
              VALUES (?,?,?,?,?,?,'completed')`).run(mem, mem, 'ui-proj', 'claude', '2026-01-01T00:00:00Z', 1);
  const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, facts, narrative, concepts,
      prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash, generated_by_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ['Kestrel deploy checklist', 'Heron cache eviction rule', 'Osprey retry budget'].forEach((title, i) => {
    const e = Date.UTC(2026, 8, 1 + i);
    ins.run(mem, 'ui-proj', '', 'decision', title, JSON.stringify([`fact about ${title}`]), `narrative for ${title}`, '[]', 0, 50,
      new Date(e).toISOString(), e, `ui-${i}`, 'test');
  });
  // A captured row over every edit limit (a fifth of the real store has a
  // narrative over 4000 characters): it must still be retitlable.
  const e = Date.UTC(2026, 7, 1);
  ins.run(mem, 'ui-proj', '', 'discovery', 'Plover long capture', JSON.stringify(Array.from({ length: 30 }, (_, i) => `plover fact ${i}`)),
    'Plover narrative sentence.\n'.repeat(200), '[]', 0, 50, new Date(e).toISOString(), e, 'ui-long', 'test');
  db.close();
  writeFileSync(join(HOME, '.claude-brain', 'READY'), 'ok\n');
}
const row = (id) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try { return db.prepare('SELECT id, title, facts, narrative, status, pinned_at FROM observations WHERE id = ?').get(id); }
  finally { db.close(); }
};

const PORT = 39000 + ((process.pid + 29) % 900);
const DEBUG_PORT = 39900 + (process.pid % 90);
const srv = spawn(process.execPath, [fileURLToPath(new URL('../ui/server.mjs', import.meta.url))],
  { env: { ...process.env, HOME, BRAIN_UI_PORT: String(PORT), BRAIN_EMBED: '0' }, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(ROOT, 'chrome')}`,
  '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--disable-sync', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const exceptions = [];
function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  });
}
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function until(expr, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await js(expr)) return; } catch { /* page still loading */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function shot(name) {
  const dir = process.env.CURATE_UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, 'base64'));
}
// Open a list row's memory and wait for ITS modal (the hidden modal keeps the
// previous body, so clear it first or a stale button could be clicked).
async function openRow(text) {
  await js(`(()=>{closeModal();document.getElementById('modalBody').innerHTML='';[...document.querySelectorAll('#results tr.memrow')].find(r=>r.textContent.includes(${JSON.stringify(text)})).click();})()`);
  await until("!document.getElementById('modal').classList.contains('hidden') && document.querySelector('#modalBody .memacts')", 'the modal');
}
const click = (text, scope = '#modalBody') =>
  js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!b)return false;b.click();return true;})()`);

try {
  // Both processes up.
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const up = await fetch(`http://127.0.0.1:${PORT}/api/memory/stats`).then((r) => r.ok).catch(() => false);
      if (!up) continue;
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      target = list.find((x) => x.type === 'page');
    } catch { /* not yet */ }
  }
  if (!target) throw new Error('server or Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until("typeof showView==='function' && document.readyState==='complete'", 'the panel to load');

  await t('Memory tab lists memories with the All / Pinned / Deleted views', async () => {
    await js("showView('mem')");
    await until("document.querySelectorAll('#results tr.memrow').length===4", 'four rows');
    const chips = await js("[...document.querySelectorAll('#memViews .chip')].map(b=>b.textContent)");
    // Labels are plain words; the pin / trash marks are inline SVG icons (no text).
    assert(JSON.stringify(chips.map((c) => c.trim())) === JSON.stringify(['All', 'Pinned', 'Deleted']), `chips: ${chips}`);
  });

  await t('opening a memory shows Pin / Edit / Delete', async () => {
    await openRow('Heron');
    const btns = await js("[...document.querySelectorAll('#modalBody .memacts button')].map(b=>b.textContent)");
    for (const b of ['Pin', 'Edit', 'Delete']) assert(btns.some((x) => x.includes(b)), `button ${b} in ${btns}`);
    await shot('1-modal');
  });

  await t('Pin: badge in the modal, pin mark in the list, row in the Pinned view, pinned_at set', async () => {
    assert(await click('Pin'), 'pin button');
    await until("document.querySelector('#modalBody .mbadge.pin')", 'pinned badge');
    await until("[...document.querySelectorAll('#results tr.memrow')].some(r=>r.textContent.includes('Heron')&&r.querySelector('.pinmark'))", 'pin mark in list');
    assert(row(2).pinned_at, 'pinned_at written');
    await js("closeModal();memView('pinned')");
    await until("document.querySelectorAll('#results tr.memrow').length===1", 'one pinned row');
    await js("memView('live')");
    await until("document.querySelectorAll('#results tr.memrow').length===4", 'back to all');
  });

  await t('Edit: form prefilled, Save writes title/facts, modal shows the new text', async () => {
    await openRow('Heron');
    assert(await click('Edit'), 'edit button');
    await until("document.getElementById('edTitle')", 'edit form');
    assert((await js("document.getElementById('edTitle').value")) === 'Heron cache eviction rule', 'title prefilled');
    await js("document.getElementById('edTitle').value='Heron cache eviction rule (LRU)';document.getElementById('edFacts').value='evict LRU first\\nkeep 512 entries'");
    await shot('2-edit');
    assert(await click('Save'), 'save button');
    await until("document.getElementById('modalTitle').textContent==='Heron cache eviction rule (LRU)'", 'modal to show the edit');
    const r = row(2);
    assert(r.title === 'Heron cache eviction rule (LRU)', `title in store: ${r.title}`);
    assert(r.facts === JSON.stringify(['evict LRU first', 'keep 512 entries']), `facts in store: ${r.facts}`);
    await until("document.getElementById('toast').textContent.includes('Saved')", 'saved toast');
  });

  await t('Edit: an empty title is refused inline and nothing is written', async () => {
    assert(await click('Edit'), 'edit button');
    await until("document.getElementById('edTitle')", 'edit form');
    await js("document.getElementById('edTitle').value='   '");
    assert(await click('Save'), 'save button');
    await until("document.getElementById('edErr').textContent.length>0", 'inline error');
    assert(row(2).title === 'Heron cache eviction rule (LRU)', 'store unchanged');
    assert(await click('Cancel'), 'cancel');
    await until("!document.getElementById('edTitle') && [...document.querySelectorAll('#modalBody .memacts button')].some(b=>b.textContent.includes('Delete'))", 'back to the memory');
  });

  await t('Delete: modal closes, row leaves the list, toast offers Undo; Undo brings it back', async () => {
    assert(await click('Delete'), 'delete button');
    await until("document.getElementById('modal').classList.contains('hidden')", 'modal closed');
    await until("document.querySelectorAll('#results tr.memrow').length===3", 'row hidden');
    await until("!document.getElementById('toast').classList.contains('hidden') && document.getElementById('toastUndo')", 'undo toast');
    assert(row(2).status === 'deleted', 'soft-deleted in the store');
    await shot('3-deleted-toast');
    await js("memView('deleted')");
    await until("document.querySelectorAll('#results tr.memrow.del').length===1", 'deleted view lists it');
    await js("memView('live')");
    await until("document.querySelectorAll('#results tr.memrow').length===3", 'live view');
    await js("document.getElementById('toastUndo').click()");
    await until("document.querySelectorAll('#results tr.memrow').length===4", 'row back after Undo');
    const r = row(2);
    assert(r.status === 'active' && r.pinned_at && r.title.endsWith('(LRU)'), `restored as it was: ${JSON.stringify(r)}`);
  });

  await t('Undo from the Deleted view: open a deleted memory → "Undo delete"', async () => {
    const res = await js(`fetch('/api/memory/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:3})}).then(r=>r.status)`);
    assert(res === 200, `delete via same-origin fetch: ${res}`);
    await js("memView('deleted')");
    await until("document.querySelectorAll('#results tr.memrow.del').length===1", 'deleted row');
    await js("document.querySelector('#results tr.memrow.del').click()");
    await until("document.querySelector('#modalBody .mbadge.st-deleted')", 'deleted badge');
    assert(await click('Undo delete'), 'undo button');
    await until("document.querySelectorAll('#results tr.memrow').length===0", 'deleted view empties');
    assert(row(3).status === 'active', 'restored');
  });

  await t('Edit a long captured row: retitle only; narrative and 30 facts kept byte for byte', async () => {
    await js("memView('live')");
    await until("document.querySelectorAll('#results tr.memrow').length===4", 'live view');
    const before = row(4);
    await openRow('Plover');
    assert(await click('Edit'), 'edit button');
    await until("document.getElementById('edTitle')", 'edit form');
    const shown = await js("document.getElementById('edNarr').value.length");
    assert(shown === before.narrative.length, `whole narrative in the form (${shown} of ${before.narrative.length})`);
    await js("document.getElementById('edTitle').value='Plover long capture (retitled)'");
    assert(await click('Save'), 'save button');
    await until("document.getElementById('modalTitle').textContent==='Plover long capture (retitled)'", 'modal to show the edit');
    const r = row(4);
    assert(r.title === 'Plover long capture (retitled)', `title in store: ${r.title}`);
    assert(r.narrative === before.narrative && r.facts === before.facts, 'narrative and facts untouched');
  });

  await t("the page's send() helper (every non-curation write) passes the server's write guard", async () => {
    // Routes whose own validation answers, so nothing is written: a guard
    // refusal would be a 403 with a different error.
    const a = await js("send('/api/secret',{name:'none'})");
    assert(a && a.error === 'unknown secret', `secret route reached: ${JSON.stringify(a)}`);
    const b = await js("send('/api/wiki/note',{})");
    assert(b && b.error === 'topic and note required', `wiki note route reached: ${JSON.stringify(b)}`);
  });

  await t('a page on another origin cannot write: no-cors fetch, CORS fetch and a <form> post are all refused', async () => {
    // The attacker: a page served from a different local port (same-site,
    // not same-origin — the closest a hostile page gets) in the same browser.
    const before = row(1);
    const panel = `http://127.0.0.1:${PORT}`;
    const evil = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><iframe name="sink"></iframe>
        <form id="f" method="POST" action="${panel}/api/memory/pin" target="sink" enctype="text/plain">
          <input name='{"id":1,"pinned":true,"x":"' value='"}'></form>`);
    });
    await new Promise((r) => evil.listen(0, '127.0.0.1', r));
    try {
      await cdp('Page.navigate', { url: `http://127.0.0.1:${evil.address().port}/` });
      await until("document.readyState==='complete' && document.getElementById('f')", 'the attacker page');
      const out = await js(`(async()=>{
        const o={};
        try{const r=await fetch('${panel}/api/memory/pin',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:JSON.stringify({id:1,pinned:true})});o.nocors=r.type;}catch(e){o.nocors='threw';}
        try{await fetch('${panel}/api/memory/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1})});o.cors='answered';}catch(e){o.cors='blocked';}
        await new Promise(res=>{const fr=document.querySelector('iframe');fr.onload=res;document.getElementById('f').submit();setTimeout(res,3000);});
        o.form='sent';return o;})()`);
      assert(out.nocors === 'opaque' && out.cors === 'blocked' && out.form === 'sent', `attempts: ${JSON.stringify(out)}`);
      await sleep(300);
      const after = row(1);
      assert(!after.pinned_at && after.status === before.status && after.title === before.title, `row 1 unchanged: ${JSON.stringify(after)}`);
    } finally {
      evil.close();
      await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await until("typeof showView==='function' && document.readyState==='complete'", 'the panel to reload');
    }
  });

  await t('no uncaught page errors', async () => {
    assert(!exceptions.length, exceptions.join(' | '));
  });
} catch (e) {
  fail++; results.push(['FAIL', 'harness', e.message]);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  srv.kill('SIGKILL');
  await sleep(300);
  rmSync(ROOT, { recursive: true, force: true });
}

for (const [s, n, m] of results) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n      ${m}` : ''}`);
console.log(`\ncurate-ui-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
