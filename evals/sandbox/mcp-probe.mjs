// Launch the brain MCP server exactly as an app's config says, and talk MCP to it.
// usage: node mcp-probe.mjs <clientName> <command> <argsJSON> <rememberText> <recallQuery>
// env passed through as-is (the harness sets the app-like HOME/PATH).
// Prints one JSON line: { ok, tools, remembered, recallHit, error }
import { spawn } from 'node:child_process';

const [client, command, argsJson, rememberText, recallQuery] = process.argv.slice(2);
const args = JSON.parse(argsJson);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buf = '', stderr = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {}
  }
});
child.stderr.on('data', (d) => { stderr += d; });
let nextId = 1;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => rej(new Error(`${method} timed out; stderr: ${stderr.slice(-300)}`)), 20000);
  waiters.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const text = (r) => (r.result?.content || []).map((c) => c.text || '').join('');
const out = { client, ok: false };
const done = (code) => { console.log(JSON.stringify(out)); try { child.kill(); } catch {} process.exit(code); };
child.on('error', (e) => { out.error = 'spawn failed: ' + e.message; done(1); });
child.on('exit', (c) => { if (!out.ok && !out.error) { out.error = `server exited ${c}; stderr: ${stderr.slice(-300)}`; done(1); } });
try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: client, version: '1.0' } });
  if (init.error) throw new Error('initialize: ' + JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rpc('tools/list', {});
  out.tools = (tl.result?.tools || []).map((t) => t.name);
  const rem = await rpc('tools/call', { name: 'brain_remember', arguments: {
    title: `Saved from ${client}`, type: 'discovery', project: 'apps-test', facts: [rememberText] } });
  out.remembered = !rem.result?.isError && /"saved":\s*true|merged|duplicate/.test(text(rem));
  if (!out.remembered) out.rememberRaw = text(rem).slice(0, 200) || JSON.stringify(rem.error || rem).slice(0, 200);
  const rec = await rpc('tools/call', { name: 'brain_recall', arguments: { query: recallQuery, limit: 10 } });
  out.recallHit = text(rec).toLowerCase().includes(recallQuery.split(' ')[0].toLowerCase());
  // "load all my memory" must return the cross-project overview, not a search
  const all = await rpc('tools/call', { name: 'brain_context', arguments: { task: 'load all my memory' } });
  try { const o = JSON.parse(text(all)); out.overview = o.overview === true && /projects/.test(o.block || ''); out.overviewProjects = ((o.block || '').match(/across \*\*(\d+)\*\* projects/) || [])[1]; }
  catch { out.overview = false; }
  out.ok = true;
  done(0);
} catch (e) { out.error = e.message; done(1); }
