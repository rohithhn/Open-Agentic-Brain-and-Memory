const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
// X-Brain-Panel: the server requires a positive same-origin signal on the
// state-changing / process-spawning GETs; a custom header is one a cross-site
// page cannot send (browsers without Sec-Fetch-Site send neither it nor Origin on GET).
const PANEL_HDR={'x-brain-panel':'1'};
const pfetch=(p,o={})=>fetch(p,{...o,headers:{...PANEL_HDR,...(o.headers||{})}});
const api=async(p,o)=>(await pfetch(p,o)).json();
// Download via fetch (so the header rides along), then hand the blob to the browser.
async function fetchDownload(url,fallbackName){
  const r=await pfetch(url);
  if(!r.ok){let m='';try{m=(await r.json()).error||'';}catch{}throw new Error(m||('HTTP '+r.status));}
  const cd=r.headers.get('content-disposition')||'';
  const mm=cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const name=mm?decodeURIComponent(mm[1]):fallbackName;
  const u=URL.createObjectURL(await r.blob());
  const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),10000);
}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const escAttr=s=>esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// Every write is a JSON POST: the server refuses any other content type (its
// cross-site guard), so writes go through these two and never through bare api().
// send() -> parsed JSON, like api(); post() also folds in the HTTP status.
const jsonPost=(p,body={})=>pfetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const send=async(p,body)=>(await jsonPost(p,body)).json();
const post=async(p,body)=>{const r=await jsonPost(p,body);
  let j={};try{j=await r.json();}catch{}return {...j,ok:r.ok&&j.ok!==false,status:r.status};};
let STATE={};
// Server/CLI text rendered verbatim (markdown, sync logs) may carry emoji from CLI
// output; the panel shows icons instead, so strip them at the edge.
const noEmoji=s=>String(s??'').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\uFE0F?\s?/gu,'');
const qa=s=>String(s??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); // for '…' inside inline handlers

// ═══════════════════════ Icons (Lucide-style, inlined: works offline) ═══════════════════════
const ICONS={
  dashboard:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  network:'<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  plug:'<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  book:'<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sparkles:'<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  key:'<path d="M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  sliders:'<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'check-circle':'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'x-circle':'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  'minus-circle':'<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  copy:'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pin:'<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  trash:'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  pencil:'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  'thumbs-up':'<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  'thumbs-down':'<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  upload:'<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  merge:'<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  zap:'<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  eye:'<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  layers:'<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  play:'<path d="M6 3 20 12 6 21 6 3z"/>',
  flask:'<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  lock:'<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  github:'<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  external:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  'arrow-right':'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-left':'<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  'chevron-right':'<path d="m9 18 6-6-6-6"/>',
  'chevron-left':'<path d="m15 18-6-6 6-6"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  tag:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  terminal:'<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  loader:'<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  cpu:'<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  list:'<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7"/><path d="M14 9h7"/><path d="M14 15h7"/><path d="M14 20h7"/>',
  inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'rotate-ccw':'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  server:'<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  folder:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chart:'<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  gauge:'<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  hash:'<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
  calendar:'<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  coins:'<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  box:'<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  rocket:'<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  brain:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>',
  // knowledge-graph zoom controls
  plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus:'<path d="M5 12h14"/>',
  maximize:'<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  crosshair:'<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
};
// No whitespace inside: an icon must add nothing to a button's textContent.
const icon=(n,cls='')=>`<svg class="i${cls?' '+cls:''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[n]||ICONS.info}</svg>`;
function hydrateIcons(root=document){$$('i[data-i]',root).forEach(el=>{if(!el.firstChild)el.innerHTML=icon(el.dataset.i);});}

// Status levels from `brain doctor` (PASS/WARN/FAIL/SKIP) -> icon + word + color, never color alone.
const LV={PASS:['ok','check-circle','OK'],WARN:['warn','alert','Attention'],FAIL:['fail','x-circle','Broken'],SKIP:['off','minus-circle','N/A']};
const STATE_LV={ok:'PASS',warn:'WARN',red:'FAIL',off:'SKIP'};
function stPill(cls,ic,text,tip,fix){
  const t=tip?` data-tip="${escAttr(tip)}"${fix?` data-tipfix="${escAttr(fix)}"`:''} tabindex="0"`:'';
  return `<span class="st st-${cls}"${t}>${icon(ic)}${esc(text)}</span>`;}
const lvPill=(level,text,tip,fix)=>{const [c,i,w]=LV[level]||LV.FAIL;return stPill(c,i,text||w,tip,fix);};

// ═══════════════════════ Motion helpers ═══════════════════════
const REDUCE=matchMedia('(prefers-reduced-motion: reduce)');
let EPOCH=0; // bumps on every view switch: lists animate in once per visit, never on background refresh
function stagger(els,step=35){if(REDUCE.matches)return;
  els.slice(0,18).forEach((k,i)=>{k.classList.remove('st-in');void k.offsetWidth;k.style.animationDelay=(i*step)+'ms';k.classList.add('st-in');
    k.addEventListener('animationend',()=>{k.classList.remove('st-in');k.style.animationDelay='';},{once:true});});}
function enter(el,sel){if(!el)return;if(el.dataset.ep===String(EPOCH))return;el.dataset.ep=EPOCH;
  const kids=sel?$$(sel,el):[...el.children];stagger(kids);
  if(!REDUCE.matches&&el.querySelector('.fill')){el.classList.remove('bars-in');void el.offsetWidth;el.classList.add('bars-in');}}
// Count numbers up from the value last shown for that stat (keyed by label),
// so a refresh with the same number does nothing and a change animates the delta.
const SHOWN=new Map();
function countUps(root){$$('.big',root).forEach(el=>{
  const raw=el.textContent.trim();if(!/^\d[\d,]*$/.test(raw)||el.children.length)return;
  const key=(el.parentElement&&el.parentElement.querySelector('h3')||{}).textContent||raw;
  const to=+raw.replace(/,/g,''),from=SHOWN.has(key)?SHOWN.get(key):0;SHOWN.set(key,to);
  if(REDUCE.matches||from===to)return;
  const t0=performance.now(),d=400,sep=raw.includes(',');
  const tick=t=>{const k=Math.min(1,(t-t0)/d),v=Math.round(from+(to-from)*(1-Math.pow(1-k,3)));
    el.textContent=sep?v.toLocaleString():String(v);if(k<1)requestAnimationFrame(tick);else el.textContent=raw;};
  el.textContent=sep?from.toLocaleString():String(from);requestAnimationFrame(tick);});}

// ═══════════════════════ State blocks: skeleton / empty / error ═══════════════════════
const skRows=(n=3)=>Array.from({length:n},()=>'<span class="sk row"></span>').join('');
function emptyState(ic,title,sub,cmd){return `<div class="empty"><div class="ei">${icon(ic)}</div><b>${esc(title)}</b>${sub?`<span>${sub}</span>`:''}${cmd?`<div class="row" style="justify-content:center">${cmdChip(cmd)}</div>`:''}</div>`;}
function errState(msg,fix){return `<div class="empty err"><div class="ei">${icon('alert')}</div><b>Could not load this</b><span>${esc(msg||'unknown error')}</span>${fix?`<span class="dim">${esc(fix)}</span>`:''}</div>`;}
function failInto(el,e,fix){if(el)el.innerHTML=errState(e&&e.message||String(e),fix||'Check that the panel server is running (it restarts itself under launchd), then reload.');}
const cmdChip=cmd=>`<code class="cmd">${esc(cmd)}</code><button class="btn sm" data-cmd="${escAttr(cmd)}" onclick="copyCmd(this)" aria-label="Copy command ${escAttr(cmd)}">${icon('copy')}Copy</button>`;
async function copyCmd(btn){const cmd=btn.dataset.cmd||'';
  let ok=false;try{await navigator.clipboard.writeText(cmd);ok=true;}catch{
    const ta=document.createElement('textarea');ta.value=cmd;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
    try{ok=document.execCommand('copy');}catch{}ta.remove();}
  if(!ok)return toast('Copy failed. Select the command and copy it by hand.',{bad:true});
  const was=btn.innerHTML;btn.innerHTML=icon('check')+'Copied';btn.disabled=true;
  setTimeout(()=>{btn.innerHTML=was;btn.disabled=false;},1600);
  toast('Copied <span class="mono">'+esc(cmd)+'</span>. Paste it into a terminal.',{ms:3500});}
// "run: brain sync" / "…then run: brain distill-sessions --install" -> the runnable part
function fixCmd(fix){if(!fix)return '';const m=String(fix).match(/\b(?:brain|gh|node bin\/[\w.-]+)(?: (?!or\b|then\b|for\b)[\w./:-]+)*/);return m?m[0].replace(/[.,;]+$/,''):'';}

// ═══════════════════════ Tooltip (hover + keyboard focus) ═══════════════════════
(()=>{const tip=$('#tip');if(!tip)return;let cur=null;
  const show=el=>{cur=el;const fix=el.dataset.tipfix;tip.innerHTML=esc(el.dataset.tip)+(fix?`<span class="tf">Fix: ${esc(fix)}</span>`:'');
    tip.classList.add('on');const r=el.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;
    let x=Math.min(Math.max(8,r.left+r.width/2-w/2),innerWidth-w-8),y=r.top-h-8;if(y<8)y=r.bottom+8;
    tip.style.left=x+'px';tip.style.top=y+'px';};
  const hide=()=>{cur=null;tip.classList.remove('on');};
  // A table cell holding one status pill is a hover target too (bigger, easier to hit).
  const host=t=>{if(!t.closest)return null;const el=t.closest('[data-tip]');if(el)return el;const td=t.closest('td');return td?td.querySelector('[data-tip]'):null;};
  const zone=el=>el.closest('td')||el;
  document.addEventListener('mouseover',e=>{const el=host(e.target);if(el&&el!==cur)show(el);});
  document.addEventListener('mouseout',e=>{if(!cur)return;const z=zone(cur);
    if(z.contains(e.target)&&!(e.relatedTarget&&z.contains(e.relatedTarget)))hide();});
  document.addEventListener('focusin',e=>{const el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el);});
  document.addEventListener('focusout',hide);addEventListener('scroll',hide,true);})();

// Keyboard: role=button / clickable rows activate with Enter and Space; collapsibles toggle.
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const el=e.target;
  if(el.matches&&el.matches('[role="button"],tr.click,.li.click,.wikitopic,.gp')&&!el.matches('button,a,input,textarea,select')){e.preventDefault();el.click();}});
document.addEventListener('click',e=>{const h=e.target.closest('[data-toggle]');if(!h)return;const c=h.closest('.coll');if(!c)return;
  const open=!c.classList.contains('open');c.classList.toggle('open',open);h.setAttribute('aria-expanded',open);});

// ═══════════════════════ Navigation ═══════════════════════
const LOADERS={graph:()=>G.ensure(),skills:()=>loadSkills(),tools:()=>loadTools(),mem:()=>loadMem(),dream:()=>loadDream(),activity:()=>loadActivity(),
  setup:()=>WIZ.open(),agents:()=>loadAgents(),about:()=>loadAboutStats(),keys:()=>loadGhConn()};
$('#nav').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  $$('.nav button').forEach(x=>{const on=x===b;x.classList.toggle('on',on);on?x.setAttribute('aria-current','page'):x.removeAttribute('aria-current');});
  EPOCH++;
  $$('.view').forEach(v=>{const on=v.dataset.view===b.dataset.v;v.classList.toggle('on',on);
    if(on){stagger([...v.children].filter(c=>!c.classList.contains('hidden')),45);}});
  const main=$('#main');if(main)main.scrollTop=0;
  const L=LOADERS[b.dataset.v];if(L)Promise.resolve().then(L).catch(err=>console.error(err));
  if(b.dataset.v==='dash')refresh();
  history.replaceState(null,'','#'+b.dataset.v);
  b.scrollIntoView({block:'nearest',inline:'nearest'});
});
function showView(v){const b=document.querySelector('.nav button[data-v="'+v+'"]');if(b)b.click();}
// Keep the "How it works" page numbers in sync with the live brain.
async function loadAboutStats(){
  try{
    const s=await api('/api/status');
    const obs=(s.totals&&s.totals.observations)||0;
    const proj=(s.projects&&s.projects.length)||0;
    if(obs)$$('.liveObs').forEach(el=>el.textContent=obs.toLocaleString());
    if(proj)$$('.liveProj').forEach(el=>el.textContent=proj);
    if(s.repo&&s.repo.owner&&s.repo.name){
      const link=$('#repoLink');
      if(link)link.href='https://github.com/'+s.repo.owner+'/'+s.repo.name;
    }
  }catch(e){}
}
// Long page: reveal sections as they scroll in.
(()=>{if(REDUCE.matches||!('IntersectionObserver' in window))return;
  const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}}),{threshold:.06});
  $$('[data-view="about"] > *').slice(3).forEach(el=>{el.classList.add('reveal');io.observe(el);});})();

// ═══════════════════════ Overview ═══════════════════════
let bootTries=0;
function statCard([k,v,sub,ic,tip]){return `<div class="card k"${tip?` title="${esc(tip).replace(/"/g,"&quot;")}"`:''}><h3>${icon(ic||'hash')}${k}</h3><div class="big">${v}</div>${sub}</div>`;}
async function refresh(){
  let s;
  try{ s=await api('/api/status'); }
  catch(e){ // server briefly down (e.g. restart) — retry fast a few times
    if(bootTries++<8){ setTimeout(refresh,1200); }
    else failInto($('#statCards'),e);
    return; }
  bootTries=0; STATE=s;
  const m=s.manifest||{}, t=s.totals||{};
  let eco=null; try{ eco=await api('/api/economics'); }catch(e){}
  try{
    const sc=$('#statCards');
    sc.innerHTML=[
      ['Observations',(t.observations??(m.memory?.observations)??'—').toLocaleString(),'<span class="sub">'+s.projects.length+' projects</span>','database'],
      ['Skills',s.skills.repo,'<span class="sub">'+s.skills.local+' on this Mac</span>','sparkles'],
      ['Summaries',(t.summaries??(m.memory?.summaries)??'—').toLocaleString(),'<span class="sub">distilled sessions</span>','layers'],
      ['Encryption',s.secrets.ageKey?'On':'Off','<span class="sub">'+(s.secrets.ageKey?'key in Keychain':'no key yet')+'</span>','lock'],
      savedCard(eco),
    ].map(statCard).join('');
    enter(sc);countUps(sc);

    $('#dKey').className='dot '+(s.secrets.ageKey?'g':'r'); $('#lKey').textContent=s.secrets.ageKey?'Key installed':'No key';
    $('#dRemote').className='dot '+(s.remote?'g':'r'); $('#lRemote').textContent=s.remote?'Cloud linked':'Not pushed yet';

    const pm=$('#projMini');
    pm.innerHTML=s.projects.length?'<table><thead><tr><th>Project</th><th class="n">Obs</th><th class="d hide-sm">Last seen</th></tr></thead><tbody>'+
      s.projects.slice(0,8).map(p=>`<tr><td class="title">${esc(p.project)}</td><td class="n">${Number(p.observations).toLocaleString()}</td><td class="d hide-sm">${(p.last_seen||'').slice(0,10)}</td></tr>`).join('')+'</tbody></table>'
      :emptyState('folder','No projects yet','Use any wired AI tool once; capture is automatic.');
    enter(pm,'tbody tr');

    $('#keyState').innerHTML=s.secrets.ageKey?`<div class="row" style="margin-bottom:6px">${stPill('ok','check-circle','Key installed')}</div><div class="mono" style="font-size:11px">${esc(s.recipient||'')}</div>`
      :stPill('fail','x-circle','No key yet');
    $('#manifest').innerHTML=m.lastSync?`Last sync <b style="color:var(--text)">${new Date(m.lastSync).toLocaleString()}</b> from <b style="color:var(--text)">${esc(m.hostname||'')}</b> · encryption ${m.encryption?'on':'off'}`:'Never synced yet.';
  }catch(e){ console.error('render',e); }

  try{
    const r=await api('/api/recent');const el=$('#recent');
    el.innerHTML=(r.results||[]).length?'<table style="table-layout:fixed"><thead><tr><th style="width:30%">Project</th><th>Title</th><th class="d hide-sm" style="width:92px">When</th></tr></thead><tbody>'+
      r.results.slice(0,8).map(o=>`<tr><td class="ell muted">${esc(o.project)}</td><td class="ell title" title="${escAttr(o.title||o.subtitle||'')}">${esc(o.title||o.subtitle||'')}</td><td class="d hide-sm">${(o.created_at||'').slice(0,10)}</td></tr>`).join('')+'</tbody></table>'
      :emptyState('clock','No memory yet','It fills as you work with any wired tool.');
    enter(el,'tbody tr');
  }catch(e){ failInto($('#recent'),e); }
  loadHome();
  loadFirstRun();
}

// First-run progress (/api/firstrun): what was found on this machine and how far
// memory-building is. Shown while the distiller still has work, or while a
// claude-mem history is waiting to be imported; hidden once both are done.
let FR_TIMER=null;
async function loadFirstRun(){
  const el=$('#firstRun'); if(!el) return;
  let f; try{ f=await api('/api/firstrun'); }catch(e){ el.innerHTML=''; return; }
  const pend=f.pending&&f.pending.calls||0, total=f.sessions&&f.sessions.total||0;
  const cmWaiting=f.claudeMem&&f.claudeMem.observations&&!f.claudeMem.imported;
  if(!pend&&!cmWaiting){ el.innerHTML=''; clearTimeout(FR_TIMER); return; }
  const tools=Object.entries(f.sessions.byTool||{}).sort((a,b)=>b[1]-a[1]);
  const pct=pend?Math.max(2,Math.min(99,Math.round(100*f.memories/Math.max(1,f.memories+pend)))):100;
  const eta=h=>h<=0?'done':h<1?`about ${Math.max(5,Math.round(h*60/5)*5)} minutes left`:h<36?`about ${Math.round(h)} hour${Math.round(h)===1?'':'s'} left`:`about ${Math.round(h/24)} days left`;
  const chips=tools.map(([k,v])=>`<span class="st st-off">${esc(k)} <b style="color:var(--text);font-variant-numeric:tabular-nums">${Number(v).toLocaleString()}</b></span>`).join('');
  el.innerHTML=`<div class="panel frun">
    <div class="ph"><h3>${icon(pend?'loader':'download')}${pend?'Building your memory':'Bring your claude-mem history over'}</h3>${pend?`<span class="muted">${esc(eta(f.etaHours))}</span>`:''}</div>
    ${pend?`<p style="margin:0">Found <b>${Number(total).toLocaleString()}</b> past session${total===1?'':'s'} on this computer. They're being turned into memories in the background; you can keep working.</p>
    <div class="frbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Memory building progress"><i style="--p:${pct}%"></i></div>
    <div class="frtools">${chips}</div>
    <div class="frmeta">${Number(f.memories).toLocaleString()} memories ready · ${Number(pend).toLocaleString()} chunk${pend===1?'':'s'} to go</div>`:''}
    ${cmWaiting?`<div class="row" style="margin-top:${pend?14:4}px;gap:10px;flex-wrap:wrap;align-items:center"><span>claude-mem found with <b>${Number(f.claudeMem.observations).toLocaleString()}</b> memories. Bring them over instantly (undo any time):</span>${cmdChip('brain switch-from-claude-mem --apply')}</div>`:''}
  </div>`;
  enter(el);
  clearTimeout(FR_TIMER); if(pend) FR_TIMER=setTimeout(loadFirstRun,60000);
}

// Tokens-saved stat card. The big number is a plain comma'd integer so the
// dashboard's count-up layer animates it; "est." and the tooltip keep it honest.
function savedCard(e){
  const tip=e?e.method+' Counted from the delivery ledger ('+(e.deliveries||0)+' deliveries'+(e.since?' since '+e.since:'')+').':'';
  if(!e||!e.deliveries) return ['Tokens saved','0','<span class="sub">est. · fills as memories are recalled</span>','coins',tip||'Estimate. Counts work tokens of memories handed to a model minus their read cost; nothing recorded yet.'];
  const k=e.byKind||{}, n=x=>(x&&x.saved||0).toLocaleString();
  const k2=n=>n>=1e6?(n/1e6).toFixed(1).replace(/\.0$/,'')+'M':n>=1e3?Math.round(n/1e3)+'k':String(n||0);
  const sub='est. · '+k2(e.today.saved)+' today · '+k2(e.week.saved)+' this week';
  return ['Tokens saved',(e.total.saved||0).toLocaleString(),'<span class="sub">'+sub+'</span>','coins',
    tip+' Startup '+n(k.startup)+' · recall '+n(k.recall)+' · context '+n(k.context)+'.'];
}

// ── Overview: services + memory signals + integrations ──
function ago(ms){if(ms==null)return'—';const m=Math.floor(ms/60000);if(m<60)return m+'m';const h=Math.floor(m/60);if(h<24)return h+'h';return Math.floor(h/24)+'d';}
let HOME=null;
function svcRow(name,ic,state,word,line){const lv=STATE_LV[state]||'SKIP';
  return `<div class="svc"><span class="sn">${icon(ic)}${esc(name)}</span>${lvPill(lv,word)}<span class="sd">${line}</span></div>`;}
async function loadHome(){
  let h;
  try{ h=await api('/api/home'); }catch(e){ ['#health','#signals'].forEach(s=>failInto($(s),e)); return; }
  HOME=h; const s=h.signals, ig=h.integrations, hl=h.health||{};
  try{
    const chip=(label,val,cls)=>`<span class="st st-${cls}" style="margin:0 6px 6px 0">${esc(label)} <b style="color:var(--text);font-variant-numeric:tabular-nums">${Number(val||0).toLocaleString()}</b></span>`;
    $('#signals').innerHTML=chip('Memories',s.memories,'acc')+chip('Types',s.types,'off')+chip('Projects',s.projects,'off')+chip('Stale',s.stale,s.stale?'warn':'off')+chip('Conflicts',s.conflicts,s.conflicts?'fail':'off');
    const ls=$('#latestSignals');
    ls.innerHTML=(s.latest||[]).length?'<div class="list">'+(s.latest||[]).map(o=>`<div class="li"><span class="grow t" title="${escAttr(o.title||o.subtitle||'')}">${esc(o.title||o.subtitle||'')}</span><span class="m hide-sm">${esc(o.project)}</span><span class="m">${(o.created_at||'').slice(5,10)}</span></div>`).join('')+'</div>'
      :'<span class="muted">Nothing new yet.</span>';
    enter(ls.firstElementChild||ls);

    const cap=hl.capture||{}, wa=hl.watchAgy||{}, wk=hl.worker||{}, sy=hl.sync||{};
    const srcOrder=['claude','codex','antigravity','kilo'];
    const srcLine=srcOrder.filter(k=>cap.sources&&cap.sources[k]).map(k=>`${k} ${ago(cap.sources[k].ageMs)}`).join(' · ')||'no sources yet';
    const capLine=cap.lastObs?`Last observation ${ago(cap.ageMs)} ago · <span class="dim">${esc(srcLine)}</span>`:'No observations yet';
    const waLine=wa.state==='ok'?'Running':wa.state==='red'?'Stopped. Restart with <span class="mono">brain watch-agy --install</span>':'Not installed';
    const wkLine=wk.alive?'Search backend up':'Not detected; search features degrade until it lazy-starts';
    const syLine=sy.lastSync?`${ago(sy.ageMs)} ago${sy.stale?'. Stale: run <span class="mono">brain sync</span>':''}`:'Never synced';
    const word=st=>st==='ok'?'OK':st==='red'?'Down':st==='warn'?'Degraded':'Off';
    const he=$('#health');
    he.innerHTML=svcRow('Capture','activity',cap.state,word(cap.state),capLine)+svcRow('Antigravity watcher','eye',wa.state,word(wa.state),waLine)+
      svcRow('claude-mem worker','server',wk.state,word(wk.state),wkLine)+svcRow('Daily sync','refresh',sy.state,word(sy.state),syLine);
    enter(he);

    const all=[...ig.tools,...ig.mcp,...ig.keys];
    $('#intCount').textContent='· '+ig.toolCount+' tools · '+ig.mcpCount+' MCP servers · '+ig.keys.length+' API keys';
    $('#integrations').innerHTML=all.length?'<div class="skgrid">'+all.map(x=>`<div class="tool" style="padding:11px 13px"><div class="th"><b style="font-size:13px">${esc(x.name)}</b>${stPill('ok','check',x.status)}</div><div class="meta">${esc(x.kind)}</div></div>`).join('')+'</div>'
      :emptyState('plug','Nothing detected','Install an AI CLI or MCP server and it shows up here.');
    if(!HEALTH_AT)renderHealth(null); // first paint uses /api/home until the doctor probe answers
  }catch(e){ console.error('home',e); }
}

// ── Health hero: one sentence + the top problems, each with a copyable fix ──
let HEALTH_AT=0, MCP=null;
function problemsFrom(m){
  const P=[];
  if(m&&Array.isArray(m.doctor)){
    for(const r of m.doctor)if(r.level==='FAIL'||r.level==='WARN')P.push({level:r.level,title:r.label,detail:r.detail,fix:r.fix,key:r.label});
  }else if(HOME&&HOME.health){ // older server without doctor rows: derive from the same health signals
    const hl=HOME.health;
    if(hl.watchAgy&&hl.watchAgy.state==='red')P.push({level:'FAIL',title:'watcher (agy)',detail:'installed, not running',fix:'run: brain watch-agy --install'});
    if(hl.sync&&hl.sync.state==='red')P.push({level:'WARN',title:'daily sync',detail:'last sync is stale',fix:'run: brain sync'});
    if(hl.worker&&hl.worker.state!=='ok')P.push({level:'WARN',title:'search worker',detail:'not running (search/index features degraded)',fix:null});
    if(hl.capture&&hl.capture.state==='red')P.push({level:'WARN',title:'capture',detail:'stale: no recent observations',fix:'use a wired tool once'});
  }
  if(m){
    for(const t of (m.tools||[]))if(t.installed)for(const [k,c] of Object.entries(t.checks||{}))
      if(c.level==='FAIL'||(c.level==='WARN'&&fixCmd(c.fix)))P.push({level:c.level,title:t.name+' · '+k,detail:c.detail,fix:c.fix});
    const pr=m.probe||{};
    if(!pr.ok&&!pr.skipped)P.push({level:'FAIL',title:'MCP memory server',detail:'probe failed'+(pr.error?': '+pr.error:''),fix:'run: brain onboard'});
  }
  return P.sort((a,b)=>(a.level==='FAIL'?0:1)-(b.level==='FAIL'?0:1));
}
function probItem(p){const fail=p.level==='FAIL',cmd=fixCmd(p.fix);
  const fixTxt=p.fix&&(!cmd||p.fix.replace(/^run:\s*/,'')!==cmd)?`<div class="ptxt">Fix: ${esc(p.fix)}</div>`:'';
  return `<li class="prob ${fail?'fail':'warn'}"><span class="pi">${icon(fail?'x-circle':'alert')}</span>
    <div style="min-width:0"><div class="pt">${esc(p.title)} ${lvPill(p.level,fail?'Failing':'Warning')}</div><div class="pd">${esc(p.detail||'')}</div>${fixTxt}</div>
    <div class="pf">${cmd?cmdChip(cmd):''}</div></li>`;}
function renderHealth(m){
  const all=problemsFrom(m);
  const dist=all.find(p=>p.key==='distiller');
  const P=all.filter(p=>p!==dist);
  const fails=all.filter(p=>p.level==='FAIL').length, warns=all.length-fails;
  // distiller: its own banner — capture without it means sessions never become memories
  const da=$('#distillerAlert');
  if(da){const cmd=dist&&fixCmd(dist.fix);
    da.innerHTML=dist?`<div class="alertbar${dist.level==='FAIL'?'':' warn'}" role="alert"><span class="pi">${icon('cpu')}</span>
      <div style="min-width:0"><b>${dist.level==='FAIL'?'Distiller is not running: captured sessions are not becoming memories':'Distiller needs attention'}</b><p>${esc(dist.detail||'')}${dist.fix&&!cmd?' · Fix: '+esc(dist.fix):''}</p></div>
      <div class="pf row">${cmd?cmdChip(cmd):''}</div></div>`:'';
    if(dist)enter(da);}
  const hero=$('#hero'),orb=$('#heroOrb');
  const cls=fails?'fail':warns?'warn':'ok';
  hero.classList.remove('ok','warn','fail');hero.classList.add(cls);
  orb.className='orb '+cls;orb.innerHTML=icon(fails?'x-circle':warns?'alert':'check-circle');
  $('#heroLine').textContent=fails?`${fails} problem${fails>1?'s':''} need${fails>1?'':'s'} attention`+(warns?`, plus ${warns} warning${warns>1?'s':''}`:'')
    :warns?`Healthy, with ${warns} warning${warns>1?'s':''}`:'All systems healthy';
  const checks=m&&m.doctor?m.doctor.length+(m.tools||[]).filter(t=>t.installed).length*3:null;
  const store=m&&m.store?(m.store.kind==='native'?'native store':"claude-mem's DB"):null;
  $('#heroSub').textContent=m?[checks?checks+' checks':'',store?'reading '+store:'',m.probe&&m.probe.ok?'MCP server live':'','checked '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})].filter(Boolean).join(' · ')
    :'Quick check from service signals. Full doctor probe running';
  const ul=$('#problems'),more=$('#problemsMore');
  const top=P.slice(0,4),rest=P.slice(4);
  ul.innerHTML=top.map(probItem).join('');
  more.innerHTML=rest.length?`<div class="coll" style="margin-top:8px"><div class="ph" role="button" tabindex="0" aria-expanded="false" data-toggle style="justify-content:flex-start;gap:6px;color:var(--muted);font-size:var(--fs-sm)">${icon('chevron-down','sm chev')}Show ${rest.length} more</div><div class="collapse"><div><ul class="problems" style="margin:0">${rest.map(probItem).join('')}</ul></div></div></div>`:'';
  enter(ul);
  const nb=$('#navProblems');if(nb){nb.textContent=fails;nb.classList.toggle('hidden',!fails);nb.setAttribute('aria-label',fails+' failing checks');}
}
async function loadHealth(force){
  const btn=$('#recheckBtn');if(btn){btn.disabled=true;btn.classList.add('busy');}
  if(force){$('#heroOrb').className='orb load';$('#heroOrb').innerHTML=icon('loader');$('#heroSub').textContent='Running checks';}
  try{MCP=await send('/api/mcp');HEALTH_AT=Date.now();renderHealth(MCP);if(force)toast('Health re-checked');}
  catch(e){if(!HEALTH_AT){$('#heroLine').textContent='Could not run the health check';$('#heroSub').textContent=e.message+'. The panel server may be restarting; try Re-check in a moment.';$('#heroOrb').className='orb fail';$('#heroOrb').innerHTML=icon('alert');}}
  finally{if(btn){btn.disabled=false;btn.classList.remove('busy');}}
}

// ═══════════════════════ Tools: memory wiring (MCP server + store + per-tool doctor state) ═══════════════════════
// /api/mcp is a POST: it briefly spawns the MCP server for a live probe, so the
// tools grid renders first and this fills in after.
function shortOf(c){const d=String(c.detail||'');
  if(c.level==='PASS')return /n\/a/.test(d)?['off','minus-circle','n/a']:['ok','check-circle','OK'];
  if(c.level==='WARN')return ['warn','alert',/stale/.test(d)?'Stale':/not created|not registered|missing/.test(d)?'Missing':/informational/.test(d)?'Info':'Check'];
  if(c.level==='SKIP')return ['off','minus-circle','N/A'];
  return ['fail','x-circle','Broken'];}
async function loadMcp(){
  const el=$('#mcpPanel'); if(!el)return;
  if(!el.querySelector('table'))el.innerHTML=skRows(4);
  try{
    const m=await send('/api/mcp');MCP=m;
    const fmt=n=>n==null?'—':Number(n).toLocaleString();
    const probe=m.probe||{};
    // Tool chips: from the LIVE server when it answered, otherwise the expected
    // set, labeled as expected — never presented as verified.
    const toolNames=probe.ok&&(probe.tools||[]).length?probe.tools:['brain_remember','brain_recall','brain_context'];
    const chips=toolNames.map(t=>`<span class="tag" style="margin:0 6px 6px 0;font-family:var(--mono)">${esc(t)}</span>`).join('')
      +(probe.ok?'':' <span class="dim" style="font-size:11px">(expected, not verified live)</span>');
    const serverLine=probe.ok
      ?`${stPill('ok','check-circle','Live')} <span class="muted" style="font-size:12px">answered initialize + tools/list in ${(probe.ms/1000).toFixed(2)}s${probe.serverInfo?` · ${esc(probe.serverInfo.name||'')} v${esc(probe.serverInfo.version||'?')}`:''}</span>`
      :probe.skipped
      ?`${stPill('off','minus-circle','Not installed')} <span class="muted" style="font-size:12px">run <span class="mono">node bin/brain.mjs onboard</span> to install and wire it</span>`
      :`${stPill('fail','x-circle','Probe failed')} <span class="muted" style="font-size:12px">${esc(probe.error||'')}</span>`;
    const st=m.store||{},active=st.kind==='native'?st.native:st.claudeMem;
    const cm=st.claudeMem||{};
    const cmLine=cm.exists
      ?`installed · ${fmt(cm.observations)} obs; optional accelerator (Haiku-quality distillation), imported into the native store on every sync`
      :`not installed; optional: native capture covers all five CLI tools, but you lose Haiku-quality distillation`;
    const rows=(m.tools||[]).map(t=>{
      if(!t.installed)return`<tr><td class="muted">${esc(t.name)}</td><td colspan="3">${stPill('off','minus-circle','Not installed')}</td></tr>`;
      const c=t.checks||{},cell=x=>{if(!x)return'<span class="dim">—</span>';const [k,i,w]=shortOf(x);return stPill(k,i,w,x.detail||w,x.fix);};
      return`<tr><td class="title">${esc(t.name)}</td><td>${cell(c.capture)}</td><td>${cell(c.push)}</td><td>${cell(c.pull)}</td></tr>`;
    }).join('');
    el.innerHTML=
      `<div class="grid2" style="margin-bottom:18px">`
      +`<div><div class="eyebrow" style="margin-bottom:8px">MCP memory server</div>`
      +`<div style="font-size:13px"><span class="mono" style="color:var(--text)">${esc(m.serverName||'agentic-brain')}</span> <span class="dim">· shim ${esc((m.shim&&m.shim.state)||'?')}</span></div>`
      +`<div class="mono" style="font-size:11px;margin-top:2px">${esc((m.shim&&m.shim.path)||'')}</div>`
      +`<div style="margin-top:10px" class="row">${serverLine}</div><div style="margin-top:10px">${chips}</div></div>`
      +`<div><div class="eyebrow" style="margin-bottom:8px">Memory store</div>`
      +`<div style="font-size:13px">Reads and writes go to <b>${st.kind==='native'?'native store':"claude-mem's DB"}</b> · <b>${fmt(active&&active.observations)}</b> observations</div>`
      +`<div class="mono" style="font-size:11px;margin-top:2px">${esc(st.resolved||'')}</div>`
      +`<div class="muted" style="font-size:12px;margin-top:10px">claude-mem: ${cmLine}</div></div></div>`
      +(m.registryOk
        ?`<div class="eyebrow" style="margin-bottom:6px">Per-tool wiring</div>`
          +`<div class="tx"><table id="wiringTable"><thead><tr><th>Tool</th><th>Capture</th><th>Push</th><th>Pull</th></tr></thead><tbody>${rows}</tbody></table></div>`
          +`<div class="row" style="margin-top:12px;gap:6px;font-size:12px" aria-label="Legend">${stPill('ok','check-circle','OK')}${stPill('warn','alert','Needs attention')}${stPill('fail','x-circle','Broken')}${stPill('off','minus-circle','Not installed / n/a')}</div>`
        :errState('wiring registry unavailable','Run: brain doctor --json for detail'));
    enter($('#wiringTable')||el,'tbody tr');
  }catch(e){failInto(el,e,'The live probe spawns the MCP server; if it keeps failing, run: brain doctor');}
}

// ── Tools (detect + link) ──
let TOOLSTATE={tools:[],linked:new Set()};
async function loadTools(){
  loadMcp();
  let d;try{d=await api('/api/detect');}catch(e){return failInto($('#toolgrid'),e);}
  TOOLSTATE.linked=new Set(d.linked||[]);
  TOOLSTATE.tools=d.tools;
  $('#toolSub').textContent=`${d.detectedCount} of ${d.total} tools detected on this machine · ${TOOLSTATE.linked.size} linked to your brain`;
  const order=[...d.tools].sort((a,b)=>(b.detected-a.detected)||a.name.localeCompare(b.name));
  const tg=$('#toolgrid');
  tg.innerHTML=order.map(t=>{
    const on=TOOLSTATE.linked.has(t.id);
    return `<div class="tool ${t.detected?(on?'on':''):'off'}" data-id="${escAttr(t.id)}">
      <div class="th"><b>${esc(t.name)}</b>${t.detected?`<button class="switch" role="switch" aria-checked="${on}" aria-label="Link ${escAttr(t.name)}" onclick="toggleTool('${qa(t.id)}')"></button>`:'<span class="badge no">not found</span>'}</div>
      <div class="meta">${t.detected?`<span class="badge det">detected</span>${t.sessions?('<span>'+t.sessions+' sessions</span>'):''}${t.lastActive?('<span class="dim">'+t.lastActive.slice(0,10)+'</span>'):''}`:'&nbsp;'}</div>
      <div class="path">${esc(t.path||'')}</div></div>`;
  }).join('')||emptyState('plug','No tools found','Install Claude Code, Codex, Cursor or Antigravity CLI.');
  enter(tg);
  $('#keygrid').innerHTML=d.keys.length?d.keys.map(k=>`<span style="display:inline-flex;margin:0 6px 6px 0">${k.present?stPill('ok','check-circle',k.name):stPill('off','minus-circle',k.name)}</span>`).join('')
    :'<span class="muted">No provider keys found in your shell environment.</span>';
}
function toggleTool(id){if(TOOLSTATE.linked.has(id))TOOLSTATE.linked.delete(id);else TOOLSTATE.linked.add(id);loadToolsRender();}
function loadToolsRender(){
  $('#toolSub').textContent=`${TOOLSTATE.tools.filter(t=>t.detected).length} of ${TOOLSTATE.tools.length} tools detected · ${TOOLSTATE.linked.size} linked`;
  document.querySelectorAll('#toolgrid .tool').forEach(el=>{const on=TOOLSTATE.linked.has(el.dataset.id);const sw=el.querySelector('.switch');if(sw){sw.setAttribute('aria-checked',on);el.classList.toggle('on',on);}});}
async function saveTools(){
  const unlinked=TOOLSTATE.tools.filter(t=>t.detected&&!TOOLSTATE.linked.has(t.id)).map(t=>t.id);
  try{const r=await send('/api/tools',{unlinked});
    toast(r.ok?(TOOLSTATE.linked.size+' tools linked · '+unlinked.length+' off'):'Could not save: '+esc(r.error||'error'),{bad:!r.ok});}
  catch(e){toast('Could not save: '+esc(e.message),{bad:true});}}

// ── tiny markdown renderer (headings, bold, code, lists, blockquote, links) ──
function md(t){if(!t)return'';const lines=noEmoji(t).split('\n');let out='',inList=false;
  const inl=s=>esc(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\.md\)/g,'<a onclick="openWiki(decodeURIComponent(\'$2\'))">$1</a>');
  for(let l of lines){
    if(/^# /.test(l)){if(inList){out+='</ul>';inList=false;}out+='<h1>'+inl(l.slice(2))+'</h1>';}
    else if(/^## /.test(l)){if(inList){out+='</ul>';inList=false;}out+='<h2>'+inl(l.slice(3))+'</h2>';}
    else if(/^\s*- /.test(l)){if(!inList){out+='<ul>';inList=true;}out+='<li>'+inl(l.replace(/^\s*- /,''))+'</li>';}
    else if(/^> /.test(l)){out+='<blockquote>'+inl(l.slice(2))+'</blockquote>';}
    else if(l.trim()===''){if(inList){out+='</ul>';inList=false;}}
    else{if(inList){out+='</ul>';inList=false;}out+='<p>'+inl(l)+'</p>';}
  }
  if(inList)out+='</ul>';return out;}

// ── modal ──
let MODAL_T=null,MODAL_FROM=null;
function openModal(title,html,ic){clearTimeout(MODAL_T);const m=$('#modal');
  if(m.classList.contains('hidden'))MODAL_FROM=document.activeElement;
  $('#modalTitle').textContent=title;$('#modalIcon').innerHTML=ic?icon(ic):'';$('#modalBody').innerHTML=html;
  m.classList.remove('closing');m.classList.remove('hidden');
  const b=$('#modalBody');b.scrollTop=0;
  setTimeout(()=>{if(!m.contains(document.activeElement))$('#modalClose').focus();},0);}
function closeModal(){const m=$('#modal');if(m.classList.contains('hidden'))return;
  if(REDUCE.matches){m.classList.add('hidden');}else{m.classList.add('closing');clearTimeout(MODAL_T);MODAL_T=setTimeout(()=>{m.classList.add('hidden');m.classList.remove('closing');},150);}
  if(MODAL_FROM&&MODAL_FROM.focus&&document.contains(MODAL_FROM))try{MODAL_FROM.focus();}catch{}}
addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();
  if(e.key==='Tab'&&!$('#modal').classList.contains('hidden')){ // keep focus inside the dialog
    const f=$$('#modal button,#modal input,#modal textarea,#modal a[href],#modal [tabindex="0"]').filter(x=>!x.disabled&&x.offsetParent);if(!f.length)return;
    const a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus();}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus();}}});

// ── small card + bar-list helpers ──
function statCards(rows){return rows.map(([k,v,sub,ic])=>`<div class="card k"><h3>${icon(ic||'hash')}${k}</h3><div class="big">${v}</div><span class="sub">${sub}</span></div>`).join('');}
function barList(rows,{key,label,onclick,color}){if(!rows||!rows.length)return'<span class="muted">None yet.</span>';
  const max=Math.max(1,...rows.map(r=>r[key]));const fill=color?`background:${color}`:'';
  return rows.map(r=>{const pct=Math.round(r[key]/max*100),lab=esc(String(r[label]??'—'));
    const clk=onclick?` onclick="${onclick}('${qa(r[label]??'')}')" role="button" tabindex="0"`:'';
    return `<div class="barrow"><div class="lab" title="${escAttr(r[label]??'')}"${clk}>${lab}</div><div class="track"><div class="fill" style="width:${pct}%;${fill}"></div></div><div class="val">${Number(r[key]).toLocaleString()}</div></div>`;}).join('');}
function cardsInto(el,rows){el.innerHTML=statCards(rows);enter(el);countUps(el);}

// ═══════════════════════ Memory ═══════════════════════
async function loadMem(){
  let m;try{m=await api('/api/memory/stats');}catch(e){failInto($('#memCards'),e);}
  if(m){
    const thisMonth=(m.byMonth[m.byMonth.length-1]||{}).n||0;
    cardsInto($('#memCards'),[
      ['Observations',Number(m.total).toLocaleString(),m.byProject.length+'+ projects','database'],
      ['Types',m.byType.length,'kinds of memory','tag'],
      ['Concepts',m.topConcepts.length+'+','distinct topics','network'],
      ['This month',Number(thisMonth).toLocaleString(),'new observations','calendar'],
    ]);
    const put=(sel,html)=>{const el=$(sel);el.innerHTML=html;enter(el);};
    put('#memByType',barList(m.byType,{key:'n',label:'type',onclick:'searchFor'}));
    put('#memByProject',barList(m.byProject,{key:'n',label:'project',onclick:'searchFor'}));
    put('#memTimeline',barList(m.byMonth,{key:'n',label:'m',color:'var(--green)'}));
    put('#memConcepts',(m.topConcepts||[]).map(c=>`<span class="wikitopic" role="button" tabindex="0" onclick="searchConcept('${qa(c.concept)}')">${esc(c.concept)} <b>${c.n}</b></span>`).join('')||'<span class="muted">None yet.</span>');
  }
  MEM={q:'',concept:'',offset:0,limit:25,total:0}; doMemQuery(); // show all memory (page 1) by default
}
function searchFor(q){MEM={q,concept:'',offset:0,limit:25,total:0};const el=$('#q');if(el){el.value=q;el.scrollIntoView({behavior:REDUCE.matches?'auto':'smooth',block:'center'});}doMemQuery();}

// ═══════════════════════ Dream / wiki ═══════════════════════
let WIKI=[];
async function loadDream(){
  try{const b=await api('/api/wiki?topic=briefing');
    $('#briefing').innerHTML=b.content?md(b.content):emptyState('moon','No briefing yet','Run Dream to write one.');}
  catch(e){failInto($('#briefing'),e);}
  try{const w=await api('/api/wiki?meta=1');WIKI=(w.pages||[]).filter(t=>!['briefing','index','lint','log','SCHEMA'].includes(t.name));
    $('#wikiCount').textContent='· '+WIKI.length+' pages';WPAGE=0;renderWikiList($('#wikifilter')?.value||'');}
  catch(e){failInto($('#wikilist'),e);}
  try{const st=await api('/api/dream/status');const L=st.lint||{contradictions:0,stale:0,orphans:0,isolated:0};
    const need=L.contradictions+L.stale+L.orphans+L.isolated;
    cardsInto($('#dreamCards'),[
      ['Concepts',st.concepts,'pages in the wiki','network'],
      ['Topics',WIKI.length,'browsable notes','book'],
      ['Data through',st.lastEpoch?new Date(st.lastEpoch).toISOString().slice(0,10):'—','latest observation','calendar'],
      ['Needs review',need,'lint items','shield'],
    ]);
    const chip=(label,n,term)=>`<button class="lintchip ${n>0?'warn':'ok'}" onclick="explain('${term}')">${icon(n>0?'alert':'check-circle','sm')}<b>${n}</b> ${label}</button>`;
    const lc=$('#lintChips');lc.innerHTML=chip('contradictions',L.contradictions,'contradictions')+chip('stale claims',L.stale,'stale')+chip('orphan pages',L.orphans,'orphans')+chip('isolated concepts',L.isolated,'isolated');enter(lc);}
  catch(e){failInto($('#dreamCards'),e);}
  loadEvalCard();
}
function renderEvalCard(last){
  $('#evalCard').innerHTML=last?
    `<div class="row" style="gap:18px;align-items:baseline"><div><div class="big" style="font-size:26px">${last.fullPct}%</div><div class="dim" style="font-size:12px;margin-top:6px">full brain · ${last.fullHits}/${last.total}</div></div>`+
    `<div><div style="font-size:18px;font-weight:600;color:var(--muted)">${last.basePct}%</div><div class="dim" style="font-size:12px;margin-top:6px">raw-obs baseline · ${last.baseHits}/${last.total}</div></div>`+
    `<span class="dim" style="font-size:12px;margin-left:auto">${(last.date||'').slice(0,10)}</span></div>`
    :emptyState('flask','Not run yet','Run the eval to score recall on your own history.');
}
async function loadEvalCard(){try{const r=await api('/api/eval');renderEvalCard(r.last);}catch(e){failInto($('#evalCard'),e);}}
async function runEvalUI(){const b=$('#evalBtn');if(b){b.disabled=true;b.classList.add('busy');}$('#evalCard').innerHTML='<span class="sk line w80"></span><span class="sk line w60"></span>';
  try{const r=await send('/api/eval');renderEvalCard(r);toast('Eval finished');}catch(e){failInto($('#evalCard'),e);}
  finally{if(b){b.disabled=false;b.classList.remove('busy');}}}
let WPAGE=0; const WLIMIT=25;
function wikiPage(d){WPAGE=Math.max(0,WPAGE+d);renderWikiList($('#wikifilter')?.value||'');}
function fmtBytes(n){return n>=1024?(n/1024).toFixed(1)+' KB':n+' B';}
function pagerHtml(cur,pages,prev,next,canPrev,canNext,extra=''){
  return `<div class="pager"><button class="btn sm" ${canPrev?'':'disabled'} onclick="${prev}">${icon('chevron-left')}Prev</button><span>Page ${cur} of ${pages.toLocaleString()}</span>${extra}<span class="sp"></span><button class="btn sm" ${canNext?'':'disabled'} onclick="${next}">Next${icon('chevron-right')}</button></div>`;}
function renderWikiList(f){f=(f||'').toLowerCase();
  const all=WIKI.filter(t=>t.name.toLowerCase().includes(f));
  const total=all.length, from=WPAGE*WLIMIT, page=all.slice(from,from+WLIMIT);
  const el=$('#wikilist');
  el.innerHTML=total?'<table><thead><tr><th>Page</th><th class="hide-sm">Section</th><th class="n">Size</th><th class="d hide-sm">Updated</th></tr></thead><tbody>'+
    page.map(t=>`<tr class="click" tabindex="0" onclick="openWiki('${qa(t.name)}')"><td class="title">${esc(t.name)}</td><td class="muted hide-sm">${esc(t.section||'page')}</td><td class="n muted">${fmtBytes(t.bytes||0)}</td><td class="d hide-sm">${(t.updated||'').slice(0,10)}</td></tr>`).join('')+'</tbody></table>'
    :emptyState('search',f?'No pages match':'No wiki pages yet',f?'Try a shorter filter.':'Run Dream to build the wiki.');
  enter(el,'tbody tr');
  const pg=$('#wikiPager');
  if(pg){const pages=Math.ceil(total/WLIMIT)||1, cur=Math.min(WPAGE+1,pages);
    pg.innerHTML=total>WLIMIT?pagerHtml(cur,pages,'wikiPage(-1)','wikiPage(1)',WPAGE>0,from+WLIMIT<total):'';}}
async function openWiki(topic){try{const r=await api('/api/wiki?topic='+encodeURIComponent(topic));
  const content=r.content||'';openModal(topic,(content?md(content):emptyState('file','This page is empty'))+aiSection(topic,content),'moon');}
  catch(e){toast('Could not open '+esc(topic)+': '+esc(e.message),{bad:true});}}
async function runDream(){const b=$('#dreamBtn');if(b){b.disabled=true;b.classList.add('busy');}$('#dreamSub').textContent='Dreaming. This can take a minute';
  try{const r=await send('/api/dream');
    if(r.ok){const x=r.result;$('#dreamSub').textContent=`Dreamed: ${x.concepts} concepts (${x.created} new, ${x.updated} updated) · ${x.ingested} new ingested · lint ${x.lint.contradictions}c/${x.lint.stale}s/${x.lint.orphans}o`;toast('Dream finished');}
    else{$('#dreamSub').textContent='Dream failed: '+(r.error||'error');toast('Dream failed: '+esc(r.error||'error'),{bad:true});}}
  catch(e){$('#dreamSub').textContent='Dream failed: '+e.message;}
  finally{if(b){b.disabled=false;b.classList.remove('busy');}}
  EPOCH++;loadDream();}

// ── Explain (instant built-in + optional AI-deeper via CLI) ──
let EXPLAIN_AI={subject:'',detail:''};
function aiSection(subject,detail){EXPLAIN_AI={subject,detail};
  return `<div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px">
    <button class="btn" id="aiBtn" onclick="explainAI()">${icon('sparkles')}Explain deeper with AI</button>
    <div id="aiOut" class="wikibody muted" style="margin-top:10px"></div></div>`;}
async function explain(term){
  let r;try{r=await api('/api/explain?term='+encodeURIComponent(term));}catch(e){return toast('Could not load the explanation: '+esc(e.message),{bad:true});}
  if(r.error){openModal('Explain',md('_No explanation available for '+esc(term)+'._'),'info');return;}
  openModal(r.title,md(r.body)+aiSection(r.title,r.body.replace(/\*\*/g,'')),'info');
}
async function explainAI(){const {subject,detail}=EXPLAIN_AI;const out=$('#aiOut'),btn=$('#aiBtn');if(!out)return;
  out.innerHTML='<span class="sk line w80"></span><span class="sk line"></span><span class="sk line w60"></span>';btn.disabled=true;btn.classList.add('busy');btn.innerHTML=icon('loader')+'Generating';
  try{const r=await send('/api/explain/ai',{subject,detail});
    out.innerHTML=r.ok?md(r.text)+`<p class="dim" style="font-size:11px;margin-top:8px">Generated via ${esc(r.tool)}</p>`:`<span style="color:var(--red)">${esc(r.error||'failed')}</span>`;}
  catch(e){out.innerHTML=`<span style="color:var(--red)">${esc(e.message)}</span>`;}
  btn.disabled=false;btn.classList.remove('busy');btn.innerHTML=icon('sparkles')+'Explain deeper with AI';}

// ── cross-project context injection ──
function injResults(r){return '<div class="list">'+(r.results||[]).map(t=>`<div class="li">${t.installed?stPill('ok','check-circle','Installed'):stPill('off','minus-circle','Not installed')}<span class="grow"><span class="t">${esc(t.label)}</span> <span class="mono" style="font-size:11px">${esc(t.file)}</span></span><span class="m">${esc(t.action)}</span></div>`).join('')+'</div>';}
async function runInject(){const o=$('#injectOut');o.innerHTML=skRows(3);
  try{const r=await send('/api/inject');o.innerHTML=r.ok?injResults(r):errState(r.error||'failed');if(r.ok){enter(o.firstElementChild);toast('Digest injected');}}
  catch(e){failInto(o,e);}}
async function previewInject(){try{const r=await api('/api/inject');
  openModal('Digest preview (dry run)',injResults(r)+'<div style="height:12px"></div>'+(r.digest?md(r.digest):emptyState('database','No memory to digest yet')),'eye');}
  catch(e){toast('Preview failed: '+esc(e.message),{bad:true});}}
async function syncClaude(){const o=$('#injectOut');o.innerHTML=skRows(3);
  try{const r=await send('/api/sync-claude');
    const row=(label,x)=>`<div class="li"><span class="grow t">${esc(label)}</span><span class="m">${esc(x)}</span></div>`;
    const plugins=(r.plugins||[]).map(p=>row('plugin · '+p.profile,p.action)).join('');
    const digests=(r.digests||[]).map(d=>row('digest · '+d.label,d.action)).join('');
    o.innerHTML=r.ok?'<div class="list">'+plugins+digests+'</div>':errState(r.error||'failed');if(r.ok){enter(o.firstElementChild);toast('Synced across Claude profiles');}}
  catch(e){failInto(o,e);}}

// ── detail openers ──
async function openSkill(id,name){let r;try{r=await api('/api/skill?id='+encodeURIComponent(id));}catch(e){return toast('Could not open skill: '+esc(e.message),{bad:true});}
  const where=r.path?'<p class="mono" style="font-size:11px;margin:0 0 12px">'+esc(r.path)+'</p>':'';
  const dl='<button class="btn" style="margin:0 0 14px" onclick="downloadSkill(\''+qa(id)+'\')">'+icon('download')+'Download this skill</button>';
  openModal(name||id,where+dl+(r.content?md(r.content):emptyState('file','No SKILL.md')),'sparkles');}
let OBS=null; // the observation open in the modal (for edit / delete / pin)
function obsFacts(o){try{const v=JSON.parse(o.facts||'[]');return Array.isArray(v)?v.map(String):[];}catch{return [];}}
function obsBadges(o){return (o.pinned?`<span class="mbadge pin">${icon('pin')}pinned</span>`:'')+(o.status&&o.status!=='active'?`<span class="mbadge st-${escAttr(o.status)}">${esc(o.status)}</span>`:'');}
function obsActions(o){if(!o.editable)return '<p class="muted" style="font-size:12px;margin:0 0 12px">Read-only: memory is still read from claude-mem\'s DB (run <span class="mono">brain import</span> to edit here).</p>';
  if(o.status==='deleted')return `<div class="memacts"><button class="btn gr" onclick="obsRestore(${o.id})">${icon('undo')}Undo delete</button></div>`;
  return `<div class="memacts"><button class="btn" onclick="obsPin(${o.id},${!o.pinned})">${icon('pin')}${o.pinned?'Unpin':'Pin'}</button>`+
    `<button class="btn" onclick="obsEdit()">${icon('pencil')}Edit</button><button class="btn danger" onclick="obsDelete(${o.id})">${icon('trash')}Delete</button></div>`;}
async function openObs(id){let r;try{r=await api('/api/observation?id='+id);}catch(e){return toast('Could not open #'+id+': '+esc(e.message),{bad:true});}
  const o=r.observation;if(!o)return;OBS=o;
  const factsArr=obsFacts(o);
  const facts=factsArr.map(f=>'<li>'+esc(f)+'</li>').join('');
  const title=o.title||o.subtitle||'observation';
  const detail=`${title} (${o.type} in ${o.project}). ${o.narrative||''} ${factsArr.join('. ')}`.trim();
  openModal(title,
    `<p class="muted" style="margin-top:0;font-size:12.5px"><span class="mono">#${o.id}</span> · ${esc(o.project)} · ${esc(o.type)} · ${(o.created_at||'').slice(0,10)} ${obsBadges(o)}</p>`+obsActions(o)+
    (o.narrative?`<p>${esc(o.narrative)}</p>`:'')+(facts?`<h2>Facts</h2><ul>${facts}</ul>`:'')+aiSection(title,detail));}
// Limits for new text (curate.mjs EDIT_LIMITS). A captured row may already be
// longer: it keeps its own size as the cap, so it can be kept or shortened.
const ED_MAX={title:200,narrative:4000};
let ED0=null; // the edit form's fields as first rendered — only changed ones are sent
function obsEdit(){const o=OBS;if(!o)return;
  const tMax=Math.max(ED_MAX.title,(o.title||'').length),nMax=Math.max(ED_MAX.narrative,(o.narrative||'').length);
  const long=(o.narrative||'').length>ED_MAX.narrative?`<p class="muted" style="font-size:12px;margin:2px 0 6px">This narrative is ${(o.narrative||'').length} characters, over the ${ED_MAX.narrative} for new text. You can keep it as is or shorten it.</p>`:'';
  openModal('Edit memory #'+o.id,
    `<p class="muted" style="font-size:12.5px;margin:0 0 10px">${esc(o.project)} · ${esc(o.type)}. Secrets you type are redacted on save; the old text is kept in the edit log beside the store. Edits apply to this Mac's store.</p>`+
    `<label class="flabel" for="edTitle">Title</label><input id="edTitle" maxlength="${tMax}" value="${escAttr(o.title||'')}"/>`+
    `<label class="flabel" for="edNarr">Narrative</label><textarea id="edNarr" rows="5" maxlength="${nMax}">${esc(o.narrative||'')}</textarea>`+long+
    `<label class="flabel" for="edFacts">Facts <span class="dim" style="text-transform:none;letter-spacing:0">(one per line)</span></label><textarea id="edFacts" rows="6">${esc(obsFacts(o).join('\n'))}</textarea>`+
    `<div id="edErr" class="ederr" role="alert"></div><div class="memacts"><button class="btn pri" id="edSave" onclick="obsSave(${o.id})">${icon('check')}Save</button><button class="btn" onclick="openObs(${o.id})">Cancel</button></div>`,'pencil');
  // Read back what the browser actually shows (it normalises line endings):
  // comparing against that, not the raw row, is what "unchanged" means here.
  ED0={title:$('#edTitle').value,narrative:$('#edNarr').value,facts:$('#edFacts').value};
  const t=$('#edTitle');if(t)t.focus();}
async function obsSave(id){const btn=$('#edSave');
  const now={title:$('#edTitle').value,narrative:$('#edNarr').value,facts:$('#edFacts').value};
  const body={id};
  for(const k of ['title','narrative','facts'])if(!ED0||now[k]!==ED0[k])body[k]=k==='facts'?now.facts.split('\n'):now[k];
  if(Object.keys(body).length===1){toast('No changes');return openObs(id);}
  if(btn)btn.disabled=true;
  const r=await curatePost('/api/memory/edit',body);
  if(!r.ok){$('#edErr').textContent=r.error||('Save failed ('+r.status+')');if(btn)btn.disabled=false;return;}
  toast((r.changed&&r.changed.length?`Saved #${id}`+(r.redacted?` · ${r.redacted} secret(s) redacted`:''):'No changes')+prepTail(r));
  await openObs(id);doMemQuery();}
// The first write to a store the lifecycle migration has not reached takes a
// verified backup of the whole brain.db first (seconds on a large store): say
// so up front instead of looking frozen, and keep the buttons from double-firing.
async function curatePost(path,body){
  const btns=[...document.querySelectorAll('#modal .memacts .btn')];
  if(OBS&&OBS.prep){btns.forEach(b=>b.disabled=true);
    toast('Preparing the store for editing: a one-time verified backup of brain.db runs first. This can take several seconds.',{ms:120000,ic:'loader'});}
  const r=await post(path,body);
  btns.forEach(b=>b.disabled=false);
  if(r.ok&&OBS)OBS.prep=false;
  return r;}
function prepTail(r){return r&&r.prepared?` · one-time backup saved to <span class="mono">${esc(r.prepared)}</span>`:'';}
async function obsDelete(id){const r=await curatePost('/api/memory/delete',{id});
  if(!r.ok)return toast('Delete failed: '+esc(r.error||r.status),{bad:true});
  closeModal();doMemQuery();
  toast(`Deleted #${id} on this Mac: hidden from recall, context and startup`+prepTail(r),{undo:()=>obsRestore(id),ic:'trash'});}
async function obsRestore(id){const r=await curatePost('/api/memory/restore',{id});
  if(!r.ok)return toast('Undo failed: '+esc(r.error||r.status),{bad:true});
  toast(`Restored #${id}`+(r.to&&r.to!=='active'?` (${esc(r.to)})`:'')+prepTail(r),{ic:'undo'});
  if(!$('#modal').classList.contains('hidden')&&OBS&&OBS.id===id)await openObs(id);doMemQuery();}
async function obsPin(id,pinned){const r=await curatePost('/api/memory/pin',{id,pinned});
  if(!r.ok)return toast((pinned?'Pin':'Unpin')+' failed: '+esc(r.error||r.status),{bad:true});
  toast((pinned?`Pinned #${id} on this Mac: always in recall, context and startup`:`Unpinned #${id}`)+prepTail(r),{ic:'pin'});
  await openObs(id);doMemQuery();}

// ── toast (bottom-right; optional Undo) ──
let TOAST_T=null,TOAST_OUT=null;
function hideToast(){const el=$('#toast');if(!el||el.classList.contains('hidden'))return;
  if(REDUCE.matches){el.classList.add('hidden');return;}
  el.classList.add('out');clearTimeout(TOAST_OUT);TOAST_OUT=setTimeout(()=>{el.classList.add('hidden');el.classList.remove('out');},220);}
function toast(html,{undo=null,bad=false,ms=8000,ic=null}={}){const el=$('#toast');if(!el)return;
  clearTimeout(TOAST_OUT);el.classList.remove('out');
  el.innerHTML=`<span class="ti">${icon(ic||(bad?'alert':'check-circle'))}</span><span class="tm">${html}</span>`+(undo?`<button class="btn sm" id="toastUndo">${icon('undo')}Undo</button>`:'')+
    `<button class="btn ghost sm icon" aria-label="Dismiss" onclick="hideToast()">${icon('x')}</button>`;
  el.classList.toggle('bad',!!bad);el.classList.remove('hidden');el.classList.remove('show');void el.offsetWidth;el.classList.add('show');
  if(undo)$('#toastUndo').onclick=()=>{el.classList.add('hidden');clearTimeout(TOAST_T);undo();};
  clearTimeout(TOAST_T);TOAST_T=setTimeout(hideToast,ms);}

// ═══════════════════════ Activity ═══════════════════════
async function loadActivity(){
  let a;try{a=await api('/api/activity');}catch(e){return failInto($('#actChart'),e);}
  $('#actSub').textContent=`${a.totalSessions} sessions · ${a.totalHours}h of focused work · last ${a.days.length} days`;
  cardsInto($('#actCards'),[
    ['Sessions',a.totalSessions,'last '+a.days.length+' days','activity'],
    ['Focused hours',a.totalHours+'h','from session durations','clock'],
    ['Tools active',(a.byTool||[]).length,'platforms feeding the brain','plug'],
    ['Busiest day',(a.days.slice().sort((x,y)=>y.sessions-x.sessions)[0]?.sessions)||0,'sessions in a day','chart'],
  ]);
  const max=Math.max(1,...a.days.map(d=>d.sessions));
  const ch=$('#actChart');
  ch.innerHTML=a.days.length?a.days.slice().reverse().map(d=>{
    const pct=Math.round(d.sessions/max*100);
    return `<div class="barrow" style="grid-template-columns:92px minmax(0,1fr) 92px"><div class="lab" style="font-variant-numeric:tabular-nums">${esc(d.day)}</div>
      <div class="track"><div class="fill" style="width:${pct}%;background:var(--green)"></div></div>
      <div class="val">${d.sessions} <span class="dim" style="font-weight:400">· ${d.hours}h</span></div></div>`;
  }).join(''):emptyState('activity','No sessions yet','Sessions appear as your AI tools are used.');
  enter(ch);
  const bt=$('#actByTool');
  bt.innerHTML=(a.byTool||[]).length?'<div class="list">'+a.byTool.map(t=>`<div class="kv"><span>${esc(t.tool)}</span><span style="color:var(--text);font-weight:600;font-variant-numeric:tabular-nums">${t.sessions}</span></div>`).join('')+'</div>':'<span class="muted">No tools yet.</span>';
  enter(bt.firstElementChild||bt);
  $('#actTasks').innerHTML=AUTOMATIONS.map(([n,s])=>`<div class="kv"><span>${n}</span><span>${s}</span></div>`).join('');
}
const AUTOMATIONS=[['Cloud sync (push)','launchd · daily 09:30'],['Ingest linked tools','on every sync'],['Build memories from sessions','every 15 minutes'],['Dream (distill memory)','on every sync'],['Session-start pull','each Claude Code session']];

// ═══════════════════════ Agents / learnings ═══════════════════════
let AGENT={role:'engineer',roleName:'Engineer'},LASTRUN=null;
async function loadAgents(){
  loadLearnings();loadDrafts();
}
// Open a learning (or draft) to inspect its full stored content & structure.
async function openLearning(file,isDraft){
  const ep=isDraft?'/api/learn/drafts':'/api/learnings';
  let r;try{r=await api(ep+'?file='+encodeURIComponent(file));}catch(e){return toast('Could not open: '+esc(e.message),{bad:true});}
  const body=`<div class="eyebrow" style="margin-bottom:10px">${isDraft?'Pending draft':'Learning'} · <span class="mono" style="text-transform:none;letter-spacing:0">${esc(file)}</span></div>`+md(r.content||'*(empty)*');
  openModal(isDraft?'Pending learning (draft)':'Learning',body,isDraft?'inbox':'book');
}
function pickRole(id,name){AGENT.role=id;AGENT.roleName=name;$('#agentRoleLabel').textContent=name;
  document.querySelectorAll('#agentRoles .tool').forEach(el=>el.classList.toggle('on',el.dataset.role===id));}
async function runAgentUI(){
  const task=$('#agentTask').value.trim(); if(!task)return toast('Describe a task first.',{bad:true});
  const tool=$('#agentTool').value;
  $('#saveLearnBtn').classList.add('hidden');
  $('#agentStatus').textContent='Running via '+tool+' (may take a while)';$('#agentOut').textContent='Dispatching to '+tool+' with your brain context…';
  try{
    const r=await send('/api/agent',{role:AGENT.role,tool,task});
    if(r.error){$('#agentOut').textContent='Error: '+r.error;$('#agentStatus').textContent='';return;}
    $('#agentStatus').textContent=`Done · ${r.result.tool} · ${r.result.injectedMemories} memories/learnings injected`;
    $('#agentOut').textContent=r.result.output||'(no output)';
    LASTRUN={role:AGENT.roleName,tool:r.result.tool,task,output:r.result.output,injectedLearnings:r.result.injectedLearnings||[]};
    $('#saveLearnBtn').classList.remove('hidden');
    renderLearnFeedback(LASTRUN.injectedLearnings);
  }catch(e){$('#agentOut').textContent='Error: '+e.message;$('#agentStatus').textContent='';}
}
function renderLearnFeedback(learnings){
  const el=$('#agentFeedback');if(!el)return;
  if(!learnings||!learnings.length){el.innerHTML='';return;}
  el.innerHTML='<div class="muted" style="font-size:12px;margin:8px 0 4px">Injected learnings: was each helpful?</div>'+
    learnings.map(l=>`<div class="li">
      <span class="grow t" style="font-size:12px">${esc((l.title||'').slice(0,80))}</span>
      <button class="btn sm icon" aria-label="Helpful" onclick="learnFeedback('${qa(l.file)}','up',this)">${icon('thumbs-up')}</button>
      <button class="btn sm icon" aria-label="Not helpful" onclick="learnFeedback('${qa(l.file)}','down',this)">${icon('thumbs-down')}</button>
    </div>`).join('');
}
async function learnFeedback(file,dir,el){
  await send('/api/learn/feedback',{file,direction:dir});
  if(el){el.parentElement.querySelectorAll('button').forEach(b=>b.disabled=true);toast(dir==='up'?'Thanks, marked helpful':'Noted, marked not helpful');}
}
async function saveLearn(){
  if(!LASTRUN)return;
  const r=await send('/api/learn',LASTRUN);
  if(r.ok){$('#saveLearnBtn').classList.add('hidden');toast('Saved to learnings. It will be reused in future runs.');loadLearnings();}
}
async function loadLearnings(){
  const el=$('#learnList');
  let r;try{r=await api('/api/learnings');}catch(e){return failInto(el,e);}
  const L=r.learnings||[];
  $('#learnCount').textContent='· '+L.length;
  el.innerHTML=L.length?'<div class="list">'+L.slice(0,20).map(l=>`<div class="li click" role="button" tabindex="0" onclick="openLearning('${qa(l.file||'')}',false)"><span class="grow t">${esc(l.title)}</span><span class="m hide-sm">${esc(l.role||'')}</span><span class="m">${(l.when||'').slice(0,10)}</span>${icon('chevron-right','sm')}</div>`).join('')+'</div>'
    :emptyState('book','No learnings yet','Approve a pending learning above to add it to the library.');
  enter(el.firstElementChild||el);
}

// ── Pending learnings (auto-distilled drafts — never auto-approved) ──
async function loadDrafts(){
  const el=$('#draftList');
  let r;try{r=await api('/api/learn/drafts');}catch(e){return failInto(el,e);}
  const D=r.drafts||[];
  $('#draftCount').textContent='· '+D.length;
  el.innerHTML=D.length?'<div class="list">'+D.map(d=>`<div class="li">
    <span class="grow" style="cursor:pointer;min-width:0" role="button" tabindex="0" onclick="openLearning('${qa(d.file)}',true)"><span class="t" style="display:block;font-weight:500">${esc(d.title)}</span><span class="m" style="display:block;overflow:hidden;text-overflow:ellipsis">${esc(d.project)} · ${esc(d.draftFile||'')}</span></span>
    <button class="btn sm gr" onclick="approveDraft('${qa(d.file)}')">${icon('check')}Approve</button>
    <button class="btn sm" onclick="dismissDraft('${qa(d.file)}')">${icon('x')}Dismiss</button>
  </div>`).join('')+'</div>':emptyState('inbox','Nothing to review','The nightly distiller proposes learnings here.');
  enter(el.firstElementChild||el);
}
async function approveDraft(file){
  await send('/api/learn/drafts/approve',{file});toast('Approved into the library');
  EPOCH++;loadDrafts();loadLearnings();
}
async function dismissDraft(file){
  await send('/api/learn/drafts/dismiss',{file});toast('Draft dismissed');
  loadDrafts();
}

// ═══════════════════════ Setup wizard (8 steps) ═══════════════════════
// Mirrors what install.sh now does on its own: back-fill past sessions from every
// detected tool, start building memories, offer the claude-mem import, open this panel.
const WIZ=(()=>{
  let i=0,det=null,hm=null,fr=null;
  const kvs=rows=>'<div class="list">'+rows.map(([k,v])=>`<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')+'</div>';
  const h=(ic,t)=>`<h3 style="margin:0 0 8px;font-size:17px;font-weight:600;display:flex;gap:10px;align-items:center"><span class="orb" style="width:32px;height:32px;border-radius:9px;background:var(--accent-a);color:var(--accent);border-color:var(--accent-b)">${icon(ic)}</span>${t}</h3>`;
  const n=x=>Number(x||0).toLocaleString();
  const eta=h=>h<=0?'done':h<1?`about ${Math.max(5,Math.round(h*60/5)*5)} minutes`:h<36?`about ${Math.round(h)} hour${Math.round(h)===1?'':'s'}`:`about ${Math.round(h/24)} days`;
  const pend=()=>fr&&fr.pending&&fr.pending.calls||0;
  const cm=()=>fr&&fr.claudeMem&&fr.claudeMem.observations?fr.claudeMem:null;
  const found=()=>det.tools.filter(t=>t.detected&&t.id!=='claude_mem');
  const history=()=>{
    if(!fr) return `<p class="muted">Progress isn't available right now. The Overview shows it once the panel can read your store.</p>`;
    const tot=fr.sessions.total, p=pend();
    const freshNote=fr.pastSessions==='fresh'?`<div style="margin-top:14px"><p style="margin:0 0 8px">You chose to start fresh${fr.freshSince?` on ${esc(fr.freshSince.slice(0,10))}`:''}, so sessions from before that aren't read. Include them any time:</p>${cmdChip('brain past-sessions on')}</div>`:'';
    if(!tot) return (fr.pastSessions==='fresh'?`<p class="muted">Your memory begins with your next session in any connected tool.</p>`:`<p class="muted">No past AI sessions on this computer yet. Memories start with your next session in any connected tool.</p>`)+freshNote;
    const pct=p?Math.max(2,Math.min(99,Math.round(100*fr.memories/Math.max(1,fr.memories+p)))):100;
    const chips=Object.entries(fr.sessions.byTool).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<span class="st st-off">${esc(k)} <b style="color:var(--text);font-variant-numeric:tabular-nums">${n(v)}</b></span>`).join('');
    return `<p style="margin:0 0 10px">Found <b>${n(tot)}</b> past session${tot===1?'':'s'} across your tools. ${p?`They're being turned into memories in the background (${esc(eta(fr.etaHours))} left); you can keep working.`:`All of them are memories now.`}</p>
      <div class="frun" style="padding:0;border:0;background:none"><div class="frbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Memory building progress"><i style="--p:${pct}%"></i></div>
      <div class="frtools">${chips}</div><div class="frmeta">${n(fr.memories)} memories ready${p?` · ${n(p)} chunk${p===1?'':'s'} to go`:''}</div></div>${freshNote}`;
  };
  const cmBlock=()=>{const c=cm(); if(!c) return '';
    return c.imported?`<div class="row" style="margin-top:14px;gap:8px;align-items:center">${stPill('ok','check-circle','claude-mem imported')}<span class="muted">${n(c.observations)} memories brought over.</span></div>`
      :`<div style="margin-top:14px"><p style="margin:0 0 8px">claude-mem found with <b>${n(c.observations)}</b> memories. Bring them over instantly (undo any time):</p>${cmdChip('brain switch-from-claude-mem --apply')}</div>`;};
  const steps=[
    {t:'Welcome',render:()=>`${h('brain','Welcome to your Agentic Brain')}<p class="muted">One memory shared by all your AI tools, kept on your computer, encrypted, and backed up to your own private GitHub.</p>${kvs([['1. Find your tools','Claude Code, Codex, Cursor, Antigravity, Kilo Code and more'],['2. Read your past sessions','already started by the installer'],['3. Build memories','in the background, a little every 15 minutes'],['4. Encrypt and sync','to your own GitHub, once a day']])}<p class="muted" style="font-size:12px;margin-top:12px">The installer did most of this already. These steps show you what it found.</p>`},
    {t:'Your tools',render:()=>{const f=found();return `${h('plug','We found these on your machine')}<div class="muted" style="margin-bottom:12px">${f.length} tool${f.length===1?'':'s'} found · all connected by default (turn any off on the Tools page)</div>${f.length?`<div class="skgrid">${f.map(t=>`<div class="tool on" style="padding:11px 13px"><div class="th"><b style="font-size:13px">${esc(t.name)}</b>${stPill('ok','check','connected')}</div>${t.id==='kilo'?'<div class="meta">beta: VS Code, Cursor and the Kilo CLI</div>':''}</div>`).join('')}</div>`:emptyState('plug','No AI tools found yet','Install one, then run brain onboard again.')}<p class="muted" style="font-size:12px;margin-top:12px">Kilo Code is supported in beta, in VS Code, in Cursor and as the Kilo CLI.</p>`;}},
    {t:'Where data lives',render:()=>`${h('folder','Where your tools keep their history')}<p class="muted">Read-only: the brain never changes these files.</p><div class="tx"><table><thead><tr><th>Tool</th><th>Path</th></tr></thead><tbody>${found().map(t=>`<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.path)}</td></tr>`).join('')}</tbody></table></div>`},
    {t:'Your history',render:()=>`${h('database','Your past sessions')}${history()}${cmBlock()}`},
    {t:'Encryption key',render:()=>`${h('lock','Encryption key')}${STATE.secrets?.ageKey?`${stPill('ok','check-circle','Key installed')}<p class="muted">Your memory is encrypted before it leaves this computer. Nothing to do here.</p>`:`<p class="muted">No key yet. Generate one (first machine) or paste your existing key on the Keys page.</p><button class="btn pri" onclick="genKey()">${icon('key')}Generate key</button>`}`},
    {t:'Automation',render:()=>`${h('clock','Runs on its own')}<p class="muted">Nothing to remember. These run in the background:</p>${kvs(AUTOMATIONS)}<p class="muted" style="font-size:12px;margin-top:12px">The installer set these up. To redo it: <span class="mono">node bin/setup-automation.mjs</span></p>`},
    {t:'Review',render:()=>`${h('list','Review')}${kvs([['Tools connected',n(found().length)],['Past sessions',fr?(fr.pastSessions==='fresh'?'starting fresh':n(fr.sessions.total)+' included'):'—'],['Memories ready',n(fr?fr.memories:hm.signals.memories)],['Still building',fr?(pend()?eta(fr.etaHours)+' left':'done'):'—'],...(cm()?[['claude-mem',cm().imported?'imported':'not imported yet']]:[]),['Encryption',STATE.secrets?.ageKey?'on':'not set'],['Cloud backup',esc(STATE.remote||'not pushed yet')]])}`},
    {t:'Done',render:()=>`${h('rocket',"You're set")}<p class="muted">${pend()?`Your memory keeps filling in for ${esc(eta(fr.etaHours))}. The Overview shows progress and updates every minute.`:'Your memory is ready.'} Hit <b style="color:var(--text)">Sync now</b> on the Overview to back it up, then install it on any other computer with one command.</p><button class="btn pri" onclick="showView('dash')">Go to Overview${icon('arrow-right')}</button>`},
  ];
  async function open(){
    try{ if(!det){det=await api('/api/detect');} if(!hm){hm=await api('/api/home');} }
    catch(e){return failInto($('#wizBody'),e);}
    try{ fr=await api('/api/firstrun'); }catch{ fr=null; } // optional: the wizard still works without it
    i=0; draw(); }
  function draw(){
    $('#wizDots').innerHTML=steps.map((s,k)=>`<span class="sd${k===i?' on':k<i?' done':''}" title="${escAttr(s.t)}" aria-label="Step ${k+1}: ${escAttr(s.t)}${k<i?' (done)':k===i?' (current)':''}">${k<i?icon('check','sm'):k+1}</span>`).join('<span class="sl"></span>');
    const b=$('#wizBody');b.innerHTML=steps[i].render();b.classList.remove('fade-in');void b.offsetWidth;b.classList.add('fade-in');
    $('#wizStepLabel').textContent=`Step ${i+1} of ${steps.length} · ${steps[i].t}`;
  }
  return{open,next:()=>{if(det&&i<steps.length-1){i++;draw();}},back:()=>{if(det&&i>0){i--;draw();}}};
})();

// ═══════════════════════ Memory browser: search + concept filter + pagination ═══════════════════════
let MEM={q:'',concept:'',offset:0,limit:25,total:0};
let MEMVIEW='live'; // live | pinned | deleted — survives search/concept changes
function memView(v){MEMVIEW=v;MEM.offset=0;doMemQuery();}
function memSearch(){MEM.q=$('#q').value.trim();MEM.concept='';MEM.offset=0;doMemQuery();}
function search(){memSearch();} // backward-compat alias
function searchConcept(c){MEM={q:'',concept:c,offset:0,limit:25,total:0};const el=$('#q');if(el)el.value='';doMemQuery();const b=$('#memBar');if(b)b.scrollIntoView({behavior:REDUCE.matches?'auto':'smooth',block:'center'});}
function memPage(d){MEM.offset=Math.max(0,MEM.offset+d*MEM.limit);doMemQuery();}
function clearMemFilter(){MEM={q:'',concept:'',offset:0,limit:25,total:0};const el=$('#q');if(el)el.value='';doMemQuery();}
let MEMQ=0;
async function doMemQuery(){
  const p=new URLSearchParams();
  if(MEM.concept)p.set('concept',MEM.concept); else if(MEM.q)p.set('q',MEM.q);
  p.set('offset',MEM.offset);p.set('limit',MEM.limit);if(MEMVIEW!=='live')p.set('view',MEMVIEW);
  const vb=$('#memViews');
  if(vb)vb.innerHTML=[['live','All',null],['pinned','Pinned','pin'],['deleted','Deleted','trash']].map(([k,l,ic])=>`<button class="chip${MEMVIEW===k?' on':''}" aria-pressed="${MEMVIEW===k}" onclick="memView('${k}')">${ic?icon(ic,'sm'):''}${l}</button>`).join('');
  const res=$('#results'),my=++MEMQ;
  if(!res.querySelector('table'))res.innerHTML=skRows(6);else res.style.opacity='.55';
  let r;try{r=await api('/api/search?'+p.toString());}catch(e){res.style.opacity='';return failInto(res,e);}
  if(my!==MEMQ)return; // a newer query superseded this one
  res.style.opacity='';
  MEM.total=r.total||0;
  const from=r.total?MEM.offset+1:0, to=Math.min(MEM.offset+MEM.limit,r.total);
  const label=(MEM.concept?`concept <b style="color:var(--text)">${esc(MEM.concept)}</b>`:MEM.q?`search <b style="color:var(--text)">${esc(MEM.q)}</b>`:'all memory')+(MEMVIEW==='pinned'?' · pinned only':MEMVIEW==='deleted'?' · deleted (open one to undo)':'');
  const bar=$('#memBar');
  if(bar)bar.innerHTML=`<span class="muted">Showing <b style="color:var(--text)">${from.toLocaleString()}–${to.toLocaleString()}</b> of <b style="color:var(--text)">${(r.total||0).toLocaleString()}</b> · ${label}</span>`+((MEM.concept||MEM.q)?` <button class="chip" style="height:24px;margin-left:8px" onclick="clearMemFilter()">${icon('x','sm')}Clear</button>`:'');
  const rows=r.results||[];
  res.innerHTML=rows.length?'<table style="table-layout:fixed"><thead><tr><th style="width:24%">Project</th><th class="hide-sm" style="width:13%">Type</th><th>Title</th><th class="d" style="width:86px">When</th></tr></thead><tbody>'+
    rows.map(o=>`<tr class="memrow click${o.status==='deleted'?' del':''}" tabindex="0" onclick="openObs(${o.id})"><td class="ell muted">${esc(o.project)}</td><td class="ell muted hide-sm">${esc(o.type)}</td><td class="ell title" title="${escAttr(o.title||o.subtitle||'')}">${o.pinned?`<span class="pinmark" title="pinned">${icon('pin')}</span>`:''}${esc(o.title||o.subtitle||'')}</td><td class="d">${(o.created_at||'').slice(0,10)}</td></tr>`).join('')+'</tbody></table>'
    :MEMVIEW==='pinned'?emptyState('pin','Nothing pinned yet','Open a memory and press Pin to keep it in every context.')
    :MEMVIEW==='deleted'?emptyState('trash','Nothing deleted','Deleted memories land here so you can undo.')
    :emptyState('search','No matches','Try fewer words, or clear the filter.');
  enter(res,'tbody tr');
  const pg=$('#memPager');
  if(pg){
    const pages=Math.ceil((r.total||0)/MEM.limit)||1, cur=Math.floor(MEM.offset/MEM.limit)+1;
    pg.innerHTML=(r.total>MEM.limit)?pagerHtml(cur,pages,'memPage(-1)','memPage(1)',MEM.offset>0,MEM.offset+MEM.limit<r.total):'';
  }
}

// ═══════════════════════ Skills ═══════════════════════
let SKILLS=[];
let SKSCOPE='all';
async function loadSkills(){if(SKILLS.length){enter($('#skgrid'));return;}
  let r;try{r=await api('/api/skills');}catch(e){return failInto($('#skgrid'),e);}
  SKILLS=r.skills||[];
  renderScopeTabs();renderSkills($('#skfilter').value||'');loadExportInfo();}

// Three populations live side by side: the library you own, plugin skills owned
// by their marketplace, and each project's own .claude/skills. They are shown
// together but stay labelled — a plugin skill is a backup, not something you edit.
const SCOPES=[['all','All'],['library','Library'],['plugin','Plugins'],['project','Projects']];
function scopeCount(k){return k==='all'?SKILLS.length:SKILLS.filter(s=>s.scope===k).length;}
function renderScopeTabs(){const el=$('#skscopes');if(!el)return;
  el.innerHTML=SCOPES.filter(([k])=>scopeCount(k)>0).map(([k,label])=>
    `<button class="chip${SKSCOPE===k?' on':''}" aria-pressed="${SKSCOPE===k}" onclick="setScope('${k}')">${label} <b>${scopeCount(k)}</b></button>`).join('');
  const n=scopeCount(SKSCOPE);
  $('#skillSub').textContent=n+' skill'+(n===1?'':'s')+' · library is editable; plugin and project skills are backups';}
function setScope(k){SKSCOPE=k;renderScopeTabs();EPOCH++;renderSkills($('#skfilter').value);}

const SCOPE_TAG={library:'',plugin:'plugin',project:'project'};
// Download one skill. stopPropagation because the whole card is a click target
// that opens the reader — without it, every download would also pop the modal.
function downloadSkill(id){fetchDownload('/api/skill/export?id='+encodeURIComponent(id),id+'.zip').then(()=>toast('Download started')).catch(e=>toast('Download failed: '+esc(e.message),{bad:true}));}
function renderSkills(f){f=(f||'').toLowerCase();
  const rows=SKILLS.filter(s=>SKSCOPE==='all'||s.scope===SKSCOPE)
    .filter(s=>s.name.toLowerCase().includes(f)||(s.description||'').toLowerCase().includes(f)||(s.origin||'').toLowerCase().includes(f));
  const g=$('#skgrid');
  g.innerHTML=rows.map(s=>{
    const id=qa(s.id),nm=qa(s.name);
    const tag=SCOPE_TAG[s.scope]?`<span class="tag ${s.scope}">${esc(s.origin||s.scope)}</span>`:'';
    return `<div class="skill" role="button" tabindex="0" onclick="openSkill('${escAttr(id)}','${escAttr(nm)}')">`+
      `<button class="dl btn sm icon ghost" aria-label="Download ${escAttr(s.name)}" title="Download ${escAttr(s.name)}" onclick="event.stopPropagation();downloadSkill('${escAttr(id)}')">${icon('download')}</button>`+
      `<b>${esc(s.name)}</b>${tag}<p>${esc(s.description||'—')}</p></div>`;
  }).join('')||`<div style="grid-column:1/-1">${emptyState('search','No skills match','Try a different filter or scope.')}</div>`;
  enter(g);}

// Export: the live library on this Mac and the repo copy can differ (the repo
// copy only catches up on `brain sync`), so show both counts and paths rather
// than silently handing over whichever one happens to be selected.
let SKEXPORT=null;
async function loadExportInfo(){try{SKEXPORT=await api('/api/skills/export/info');}catch{return;}
  const sel=$('#skexportsrc');if(!sel)return;
  for(const o of sel.options){const i=SKEXPORT[o.value];if(!i)continue;
    const label={live:'This Mac: live library',repo:'Repo copy: as last synced',all:'Everything, incl. plugin & project skills'}[o.value];
    o.textContent=label+' ('+i.count+')';
    o.disabled=!i.exists;}
  sel.onchange=renderExportNote;renderExportNote();}
function renderExportNote(){const n=$('#skexportnote');if(!n||!SKEXPORT)return;
  const src=$('#skexportsrc').value,i=SKEXPORT[src];if(!i)return;
  const other=src==='live'?SKEXPORT.repo:src==='repo'?SKEXPORT.live:null;
  const drift=other&&other.exists&&other.count!==i.count
    ?' · the other copy has '+other.count+'; run a sync to close the gap':'';
  n.innerHTML='Downloads '+i.count+' skills as a <b>.'+SKEXPORT.format+'</b> from <span class="mono">'+esc(i.dir)+'</span>'+esc(drift);}
// Sync skills: mirror the library, rediscover plugin + project skills, relink.
// Streamed over SSE so each step lands as it happens — the plugin-cache and
// ~/Documents walks take seconds and a silent button looks broken.
function syncSkillsNow(){
  const b=$('#sksyncbtn'),out=$('#sksynclog');
  if(b.disabled)return;
  b.disabled=true;b.classList.add('busy');b.innerHTML=icon('refresh')+'Syncing';
  out.hidden=false;out.textContent='';
  const line=t=>{out.textContent+=noEmoji(t)+'\n';out.scrollTop=out.scrollHeight;};
  const finish=(label,ok)=>{b.disabled=false;b.classList.remove('busy');b.innerHTML=icon('refresh')+'Sync skills';if(label){line(label);toast(esc(label),{bad:ok===false});}};
  // fetch stream instead of EventSource: EventSource cannot add the same-origin header.
  let finished=false;
  const onEvent=(ev,data)=>{
    if(ev==='log'){try{line('  '+JSON.parse(data).line);}catch{}}
    else if(ev==='done'){
      let d={};try{d=JSON.parse(data);}catch{}
      finished=true;
      finish(d.ok
        ?`Done: ${d.library} library · ${d.plugins} plugin · ${d.projects} project · ${d.linked} linked in ${d.seconds}s`
        :'Failed: '+(d.error||'unknown error'),!!d.ok);
      if(d.ok){SKILLS=[];SKEXPORT=null;EPOCH++;loadSkills();}
    }
  };
  (async()=>{
    try{
      const r=await pfetch('/api/skills/sync/stream');
      if(!r.ok||!r.body)throw new Error('HTTP '+r.status);
      const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
      for(;;){
        const {value,done}=await rd.read();
        if(done)break;
        buf+=dec.decode(value,{stream:true});
        let i;
        while((i=buf.indexOf('\n\n'))>=0){
          const chunk=buf.slice(0,i);buf=buf.slice(i+2);
          let ev='message',data='';
          for(const l of chunk.split('\n')){
            if(l.startsWith('event:'))ev=l.slice(6).trim();
            else if(l.startsWith('data:'))data+=(data?'\n':'')+l.slice(5).trim();
          }
          onEvent(ev,data);
        }
      }
      if(!finished)finish();
    }catch(e){if(!finished)finish('Connection lost',false);}
  })();
}

function exportSkills(){const src=$('#skexportsrc').value,b=$('#skexportbtn');
  const was=b.innerHTML;b.innerHTML=icon('loader')+'Preparing';b.disabled=true;b.classList.add('busy');
  // fetch + blob (not a bare navigation) so the same-origin header is sent.
  fetchDownload('/api/skills/export?source='+encodeURIComponent(src),'skills-'+src+'.zip')
    .then(()=>toast('Export downloaded'))
    .catch(e=>toast('Export failed: '+esc(e.message),{bad:true})).finally(()=>{b.innerHTML=was;b.disabled=false;b.classList.remove('busy');});}

// ═══════════════════════ Sync, keys, GitHub ═══════════════════════
async function act(kind,msg){
  const log=$('#log');if(log)log.textContent=msg+'…';
  toast(esc(msg)+'…',{ic:'loader',ms:60000});
  let r;try{r=await send('/api/'+kind);}catch(e){r={error:e.message};}
  if(log)log.textContent=noEmoji(r.error?'Error: '+r.error:'Done.\n'+JSON.stringify(r.result,null,2));
  toast(r.error?'Failed: '+esc(r.error):(kind==='sync'?'Synced to the cloud':kind==='restore'?'Restored from the cloud':'Merged remote memory'),{bad:!!r.error});
  refresh();}
async function genKey(){if(!confirm('Generate a NEW key? Only on your FIRST machine. On others, paste the existing key.'))return;
  const r=await send('/api/key/generate');
  if(r.error)return toast('Error: '+esc(r.error),{bad:true});
  openModal('Key generated',`<p>Save it in your password manager.</p><div class="eyebrow" style="margin:12px 0 6px">Public (recipient)</div><div class="row">${cmdChip(r.recipient||'')}</div><p class="muted" style="margin-top:14px">Reveal the secret to copy to other Macs with:</p><div class="row">${cmdChip('brain key show')}</div>`,'key');
  refresh();}
async function importKey(){const identity=$('#identity').value.trim();if(!identity)return toast('Paste your AGE-SECRET-KEY first.',{bad:true});
  const r=await send('/api/key/import',{identity});
  if(r.error)return toast('Error: '+esc(r.error),{bad:true});$('#identity').value='';toast('Key saved to the Keychain');refresh();}
// Show the real connection. Every GitHub operation shells out to `gh`, so gh's
// own auth state is the truth — a stored PAT was never read by anything.
async function loadGhConn(){
  const el=$('#ghConn'); if(!el)return;
  let g;try{g=await send('/api/github');}catch(e){return failInto(el,e);}
  if(g.error){el.innerHTML=stPill('fail','x-circle','Could not check')+`<p class="muted" style="font-size:12px">${esc(g.error)}</p>`;return;}
  if(!g.ghInstalled){
    el.innerHTML=`${stPill('fail','x-circle','gh not installed')}
      <p class="muted" style="font-size:var(--fs-sm)">Install the GitHub CLI, then sign in. Sync needs it: the encrypted blob is stored as a Release asset.</p><div class="row">${cmdChip('gh auth login')}</div>`;return;}
  if(!g.authenticated){
    el.innerHTML=`${stPill('fail','x-circle','Not signed in')}
      <p class="muted" style="font-size:var(--fs-sm)">Run this in a terminal, then reload this page.</p><div class="row">${cmdChip('gh auth login')}</div>`;return;}
  const vis=g.visibility?(g.visibility==='private'?stPill('ok','lock','private'):stPill('warn','alert',g.visibility)):'';
  const repoLine=g.repoExists
    ? `<div class="row"><a class="btn" href="${escAttr(g.url)}" target="_blank" rel="noopener">${icon('github')}Open ${esc(g.slug)}${icon('external')}</a> ${vis}</div>`
    : `${stPill('warn','alert','Repo not created yet')}
       <p class="muted" style="font-size:var(--fs-sm)">Expected <span class="mono">${esc(g.slug)}</span>. Create it with:</p><div class="row">${cmdChip('brain init')}</div>`;
  el.innerHTML=`<div class="row">${stPill('ok','check-circle','Signed in as '+g.login)}</div>
    <div class="eyebrow" style="margin:16px 0 8px">Brain repo</div>${repoLine}
    ${g.repoExists&&g.visibility!=='private'?`<p class="muted" style="font-size:var(--fs-sm);display:flex;gap:6px;color:var(--amber)">${icon('alert')}This repo is not private. Your encrypted memory blob is a Release asset on it.</p>`:''}
    ${!g.hasRemote?'<p class="muted" style="font-size:var(--fs-sm)">No git remote configured locally yet.</p>':''}`;
}

// ═══════════════════════ Knowledge graph: a living neural map (canvas, no deps) ═══════════════════════
// Projects are glowing hubs, concepts orbit them, links taper from hub to concept and
// carry soft particles when strong. Physics settles and then stops; the render loop
// only keeps running for the gentle breathing/flow (never under reduced motion) and
// pauses whenever the view is hidden.
const G=(()=>{
  const wrap=$('#graphWrap'),stage=$('#gstage'),side=$('#gside'),cv=$('#graph'),tip=$('#gtip'),panel=$('#gpanel'),live=$('#glive');
  let ctx,W=0,H=0,dpr=1,nodes=[],edges=[],byId=new Map(),loaded=false,loading=false,data=null;
  let cam={x:0,y:0,z:1},tgt={x:0,y:0,z:1},userCam=false;
  let hover=null,sel=null,kbIdx=-1,isolate=null,showConcepts=true,query='',matches=new Set();
  let alpha=0,running=false,raf=0,t0=performance.now(),tBuild=0,dust=[],maxW=1;
  let groups=[],hueOf=new Map(),sprites=new Map(),nbrs=new Map();
  const PAL=[245,168,328,38,198,276,142,12,56,222,300,90];
  const FONT='Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
  const RM=()=>REDUCE.matches;
  const hsl=(h,s,l,a=1)=>`hsla(${h},${s}%,${l}%,${a})`;
  const hueFor=g=>hueOf.get(g)??245;
  const nb=n=>nbrs.get(n)||new Set();

  // ── sprites: pre-rendered glow + shaded orb per hue, so a frame is just drawImage calls
  function sprite(h){let s=sprites.get(h);if(s)return s;
    const mk=(sz,fn)=>{const c=document.createElement('canvas');c.width=c.height=sz;fn(c.getContext('2d'),sz);return c;};
    const glow=mk(128,(g,S)=>{const r=g.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
      r.addColorStop(0,hsl(h,95,70,.55));r.addColorStop(.25,hsl(h,90,62,.22));r.addColorStop(.6,hsl(h,90,55,.06));r.addColorStop(1,hsl(h,90,55,0));g.fillStyle=r;g.fillRect(0,0,S,S);});
    const orb=mk(96,(g,S)=>{const r=g.createRadialGradient(S*.36,S*.32,S*.02,S*.5,S*.5,S*.5);
      r.addColorStop(0,hsl(h,100,92));r.addColorStop(.35,hsl(h,85,68));r.addColorStop(.8,hsl(h,70,46));r.addColorStop(1,hsl(h,70,34));
      g.fillStyle=r;g.beginPath();g.arc(S/2,S/2,S/2-1,0,6.2832);g.fill();
      g.strokeStyle=hsl(h,100,88,.55);g.lineWidth=1.5;g.beginPath();g.arc(S/2,S/2,S/2-1.5,0,6.2832);g.stroke();});
    const dot=mk(32,(g,S)=>{const r=g.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
      r.addColorStop(0,'rgba(255,255,255,.95)');r.addColorStop(.25,hsl(h,100,80,.8));r.addColorStop(1,hsl(h,100,60,0));g.fillStyle=r;g.fillRect(0,0,S,S);});
    s={glow,orb,dot};sprites.set(h,s);return s;}

  function size(){const r=stage.getBoundingClientRect();if(!r.width)return false;
    dpr=Math.min(devicePixelRatio||1,2);W=r.width;H=r.height;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
    ctx=cv.getContext('2d');dust=Array.from({length:Math.round(W*H/7000)},()=>({x:Math.random(),y:Math.random(),r:Math.random()*1.2+.2,a:Math.random()*.35+.05,d:Math.random()*.25+.05}));
    return true;}

  // ── data: an overview layer (top topics + every project hub) plus expansion
  // layers (a project's own topics, a searched concept and its neighbours),
  // composed into one graph with stable ids so nodes keep their place.
  const DENS=[60,100,140,220,320,450];let limit=140,overview=null,layers=[],wmaxP=1,wmaxC=1,anchors=new Map();
  async function ensure(){if(loaded){size();if(!userCam)fit(null,true);kick();return;}if(loading)return;loading=true;
    size();let g;
    try{g=await api('/api/graph?limit='+limit);}catch(e){loading=false;$('#graphSub').textContent='Could not load the graph.';showEmpty('alert','Could not load the graph',esc(e.message));return;}
    loading=false;loaded=true;build(g);}
  function header(){const st=(overview&&overview.stats)||{},el=$('#graphSub');if(!el)return;
    const shown=nodes.filter(n=>!n.proj).length;
    el.innerHTML=st.projects?`Showing <b>${shown.toLocaleString()}</b> of ${Number(st.totalConcepts||shown).toLocaleString()} topics · ${st.projects.toLocaleString()} project${st.projects===1?'':'s'}${st.memories?' · '+Number(st.memories).toLocaleString()+' memories':''}. Click a project to load its own topics; search reaches every topic.`
      :'A live map of what your brain knows: projects and the concepts connecting them.';
    const d=$('#gdensv');if(d)d.textContent=limit;}
  function build(g){overview=g;layers=[];
    if(!g.nodes||!g.nodes.length){header();showEmpty('network','No knowledge graph yet','The map draws itself from the concepts tagged on your memories. After a few captured sessions, your projects and the ideas connecting them appear here.');return;}
    $('#gempty').classList.add('hidden');wrap.classList.remove('is-empty');
    groups=g.projects&&g.projects.length?g.projects:[...new Set(g.nodes.map(n=>n.group))].sort();
    // a hand-tuned palette for a few projects; golden-angle hues beyond that so neighbours never match
    groups.forEach((gp,i)=>hueOf.set(gp,groups.length<=PAL.length?PAL[i]:Math.round((245+i*137.508)%360)));
    wmaxP=Math.max(1,...g.nodes.filter(n=>n.type==='project').map(n=>n.weight));
    wmaxC=Math.max(1,...g.nodes.filter(n=>n.type==='concept').map(n=>n.weight));
    nodes=[];byId=new Map();compose();
    alpha=1;const warm=RM()?400:Math.max(40,90-nodes.length/6);for(let i=0;i<warm;i++)tick();
    tBuild=performance.now();fit(null,true);userCam=false;header();kick();}
  // seed project clusters on a sunflower spiral, biggest at the centre, spaced by cluster size
  function layoutAnchors(){const size=new Map(groups.map(g=>[g,1]));for(const n of nodes)if(!n.proj)size.set(n.group,(size.get(n.group)||1)+1);
    const order=[...groups].sort((a,b)=>size.get(b)-size.get(a)),avg=order.reduce((s,g)=>s+Math.sqrt(size.get(g)),0)/Math.max(1,order.length);
    const c=groups.length<=1?0:(groups.length<=6?150+avg*16:62+avg*20);
    order.forEach((g,i)=>{const r=c*Math.sqrt(i+(groups.length<=6&&i?0:.0)),a=i*2.39996-1.1;const an=anchors.get(g)||{};an.x=Math.cos(a)*r*(groups.length<=6?1.1:1);an.y=Math.sin(a)*r*.82;anchors.set(g,an);});}
  function radius(n){return n.type==='project'?9+Math.sqrt(Math.min(1,n.weight/wmaxP))*21:3.5+Math.sqrt(Math.min(1,n.weight/wmaxC))*9.5;}
  function compose(nearId){const all=[overview,...layers],seen=new Map(),em=new Map();
    for(const L of all){for(const n of L.nodes)if(!seen.has(n.id))seen.set(n.id,{n,home:L.focus&&L.focus!==n.id&&L.focus.startsWith('p:')?L.focus:null});
      for(const e of L.edges){const k=e.source+'|'+e.target+'|'+e.kind,o=em.get(k);if(!o||o.weight<e.weight)em.set(k,e);}}
    const old=byId,fresh=[];nodes=[];byId=new Map();let born=0;
    for(const[id,{n,home}]of seen){let o=old.get(id);
      if(o){Object.assign(o,{weight:n.weight,last:n.last,projects:n.projects});o.r=radius(o);o.home=o.home||home;}
      else{o={...n,proj:n.type==='project',x:0,y:0,vx:0,vy:0,h:hueFor(n.group),ph:Math.random()*6.2832,born:born++,appear:RM()?1:0,dim:1,vis:0,home};o.r=radius(o);fresh.push(o);}
      nodes.push(o);byId.set(id,o);}
    layoutAnchors();
    // hubs are pulled to their spiral seat; a concept to its hub (or the hub that loaded it)
    for(const n of nodes)n.an=n.proj?anchors.get(n.group):(byId.get(n.home)||byId.get('p:'+n.group)||{x:0,y:0});
    const near=nearId&&byId.get(nearId);
    for(const n of fresh){const base=near&&!n.proj?near:n.an,a=Math.random()*6.2832,d=n.proj?4:24+Math.random()*50;n.x=base.x+Math.cos(a)*d;n.y=base.y+Math.sin(a)*d;
      if(near&&!RM())n.born=n.born*.25+((performance.now()-tBuild)/16)/.5;}
    edges=[...em.values()].map(e=>({s:byId.get(e.source),t:byId.get(e.target),w:e.weight,kind:e.kind})).filter(e=>e.s&&e.t);
    maxW=Math.max(1,...edges.map(e=>e.w));
    nbrs=new Map();for(const e of edges){for(const[a,b]of[[e.s,e.t],[e.t,e.s]]){if(!nbrs.has(a))nbrs.set(a,new Set());nbrs.get(a).add(b);}}
    // particles ride the strongest links
    const strong=new Set([...edges].sort((a,b)=>b.w-a.w).slice(0,Math.min(90,Math.ceil(edges.length*.4))));
    for(const e of edges)e.parts=strong.has(e)?Array.from({length:e.w>=maxW*.5?2:1},(_,k)=>({o:Math.random()+k*.5,sp:.12+Math.random()*.1})):null;
    // order for keyboard cycling: projects first, then concepts by weight
    nodes.order=[...nodes].sort((a,b)=>(b.proj-a.proj)||(b.weight-a.weight));
    if(sel&&!byId.has(sel.id))sel=null;if(hover&&!byId.has(hover.id))hover=null;
    legend();filter(sIn?sIn.value:'');}
  // load a project's own topics or a concept's neighbourhood into the view
  let busy=0;
  async function expand(kind,name){const id=(kind==='project'?'p:':'c:')+name;
    if(layers.some(L=>L.focus===id))return byId.get(id);
    if(nodes.length>900)return byId.get(id); // keep the frame budget
    const tok=++busy;wrap.classList.add('is-busy');
    try{const g=await api('/api/graph?'+kind+'='+encodeURIComponent(name));if(!g||!g.focus)return byId.get(id);
      layers.push(g);compose(kind==='project'?id:null);
      reheat(.5);header();return byId.get(id);}
    catch(e){toast('Could not load '+esc(name)+': '+esc(e.message),{bad:true});return byId.get(id);}
    finally{if(tok===busy)wrap.classList.remove('is-busy');}}
  async function setLimit(v){limit=v;header();let g;try{g=await api('/api/graph?limit='+v);}catch(e){return toast('Could not load the graph: '+esc(e.message),{bad:true});}
    overview=g;wmaxC=Math.max(wmaxC,...g.nodes.filter(n=>n.type==='concept').map(n=>n.weight));compose();reheat(.6);if(!userCam)fit(null,false);header();}
  function showEmpty(ic,title,sub){const el=$('#gempty');el.innerHTML=`<div class="gempty-in"><div class="gempty-orb">${icon(ic)}</div><b>${esc(title)}</b><span>${sub}</span></div>`;
    el.classList.remove('hidden');wrap.classList.add('is-empty');nodes=[];edges=[];draw(performance.now());}

  // ── side panel, list mode: every project with its colour and memory count
  let listQ='',hoverRow=null;
  function legend(){if(!sel)renderList();else syncLegend();}
  function renderList(){const hubs=nodes.filter(n=>n.proj).sort((a,b)=>b.weight-a.weight);
    if(!panel.querySelector('.gl-list')){
      panel.innerHTML=`<div class="gl-head"><h3>Projects</h3><span id="glCount"></span></div>
        <div class="search gl-filter">${icon('search')}<input id="glFilter" placeholder="Filter projects" aria-label="Filter projects" autocomplete="off" spellcheck="false"/></div>
        <div class="gl-list" id="glList" role="list"></div>`;
      const f=$('#glFilter');f.value=listQ;f.addEventListener('input',()=>{listQ=f.value.trim().toLowerCase();renderList();});}
    const maxw=Math.max(1,...hubs.map(n=>n.weight)),q=listQ,shownH=q?hubs.filter(n=>n.label.toLowerCase().includes(q)):hubs;
    $('#glCount').textContent=q?`${shownH.length} of ${hubs.length}`:`${hubs.length.toLocaleString()} · ${hubs.reduce((a,n)=>a+n.weight,0).toLocaleString()} memories`;
    $('#glList').innerHTML=shownH.map(n=>`<button class="gl-row${isolate===n.group?' act':''}" role="listitem" data-id="${escAttr(n.id)}" style="--h:${n.h}" title="Focus ${escAttr(n.label)}"><span class="sw"></span><span class="gl-n">${esc(n.label)}</span><span class="gl-c">${n.weight.toLocaleString()}</span><span class="gl-bar" style="transform:scaleX(${Math.max(.03,n.weight/maxw).toFixed(3)})"></span></button>`).join('')||'<div class="muted" style="font-size:12px;padding:6px 8px">No project matches.</div>';
    sideLabel();}
  function syncLegend(){$$('.gl-row',panel).forEach(c=>c.classList.toggle('act',(sel&&c.dataset.id===sel.id)||(isolate&&c.dataset.id==='p:'+isolate)));}
  function sideLabel(){const l=$('#gsideTogL');if(l)l.textContent=sel?(sel.proj?'Project: ':'Topic: ')+sel.label:`Projects (${nodes.filter(n=>n.proj).length})`;}
  // hovering a row lights up that cluster on the map
  panel.addEventListener('mouseover',e=>{const r=e.target.closest('.gl-row');const n=r&&byId.get(r.dataset.id);if(n&&n!==hover){hoverRow=n;hover=n;kick();}});
  panel.addEventListener('mouseleave',()=>{if(hoverRow&&hover===hoverRow){hover=null;kick();}hoverRow=null;});
  const tog=$('#gsideTog');if(tog)tog.addEventListener('click',()=>openSheet(!side.classList.contains('open')));
  function openSheet(on){side.classList.toggle('open',on);if(tog)tog.setAttribute('aria-expanded',String(on));}

  // ── physics: clustered force layout that cools to rest
  function tick(){const n=nodes.length,a=alpha;
    for(const p of nodes){const k=p.proj?.05:.012;p.vx+=(p.an.x-p.x)*k*a;p.vy+=(p.an.y-p.y)*k*a;p.vx-=p.x*.002*a;p.vy-=p.y*.002*a;}
    for(let i=0;i<n;i++){const A=nodes[i];for(let j=i+1;j<n;j++){const B=nodes[j];
      let dx=A.x-B.x,dy=A.y-B.y,d2=dx*dx+dy*dy;if(d2>250000)continue;if(d2<1){dx=Math.random()-.5;dy=Math.random()-.5;d2=1;}
      const d=Math.sqrt(d2),min=A.r+B.r+(A.proj||B.proj?26:10);
      let f=(A.proj&&B.proj?5200:900+(A.r+B.r)*40)/d2*a;if(d<min)f+=(min-d)*.25;
      dx/=d;dy/=d;A.vx+=dx*f;A.vy+=dy*f;B.vx-=dx*f;B.vy-=dy*f;}}
    for(const e of edges){let dx=e.t.x-e.s.x,dy=e.t.y-e.s.y;const d=Math.sqrt(dx*dx+dy*dy)||1;
      const L=e.kind==='has'?e.s.r+e.t.r+46+(1-e.w/maxW)*50:e.s.r+e.t.r+44,k=(e.kind==='has'?.035:.012)*Math.min(1.6,.6+Math.log1p(e.w)*.3);
      const f=(d-L)*k*a;dx/=d;dy/=d;e.s.vx+=dx*f;e.s.vy+=dy*f;e.t.vx-=dx*f;e.t.vy-=dy*f;}
    for(const p of nodes){if(p.fixed){p.x=p.fx;p.y=p.fy;p.vx=p.vy=0;continue;}
      p.vx*=.82;p.vy*=.82;const sp=Math.hypot(p.vx,p.vy);if(sp>24){p.vx*=24/sp;p.vy*=24/sp;}p.x+=p.vx;p.y+=p.vy;}
    alpha*=.985;if(alpha<.004)alpha=0;}
  const reheat=(v=.35)=>{alpha=Math.max(alpha,v);kick();};

  // ── visibility and emphasis
  const shown=n=>(showConcepts||n.proj)&&(!isolate||n.group===isolate);
  function focusSet(){const f=hover||sel;if(!f)return null;const s=new Set(nb(f));s.add(f);return s;}

  // ── camera
  const toWorld=(px,py,c=cam)=>({x:(px-W/2-c.x)/c.z,y:(py-H/2-c.y)/c.z});
  const toScreen=(x,y)=>({x:x*cam.z+W/2+cam.x,y:y*cam.z+H/2+cam.y});
  const clampZ=z=>Math.max(.25,Math.min(5,z));
  function fit(set,instant){const list=(set?[...set]:nodes).filter(shown);if(!list.length||!W)return;
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;for(const n of list){const r=n.r+(n.proj?30:18);x0=Math.min(x0,n.x-r);y0=Math.min(y0,n.y-r);x1=Math.max(x1,n.x+r);y1=Math.max(y1,n.y+r);}
    const padR=0,padB=W>700?40:24,padT=W>700?64:110;
    const aw=Math.max(80,W-padR-48),ah=Math.max(80,H-padT-padB);
    const z=clampZ(Math.min(aw/(x1-x0),ah/(y1-y0),set?2.2:1.5));const cx=(x0+x1)/2,cy=(y0+y1)/2;
    tgt={z,x:-cx*z-padR/2,y:-cy*z+(padT-padB)/2};if(instant||RM())cam={...tgt};kick();}
  function zoomAt(px,py,f){const w=toWorld(px,py,tgt);const z=clampZ(tgt.z*f);tgt={z,x:px-W/2-w.x*z,y:py-H/2-w.y*z};userCam=true;if(RM())cam={...tgt};kick();}

  // ── drawing
  function curve(e){const sx=e.s.x,sy=e.s.y,tx=e.t.x,ty=e.t.y,mx=(sx+tx)/2,my=(sy+ty)/2,bend=e.kind==='related'?.18:.1;
    return [sx,sy,mx-(ty-sy)*bend,my+(tx-sx)*bend,tx,ty];}
  function qpt(c,t){const u=1-t;return[u*u*c[0]+2*u*t*c[2]+t*t*c[4],u*u*c[1]+2*u*t*c[3]+t*t*c[5]];}
  function edgePath(c,w0,w1){const dx=c[4]-c[0],dy=c[5]-c[1],L=Math.hypot(dx,dy)||1,nx=-dy/L,ny=dx/L,wm=(w0+w1)/2;
    ctx.beginPath();ctx.moveTo(c[0]+nx*w0,c[1]+ny*w0);ctx.quadraticCurveTo(c[2]+nx*wm,c[3]+ny*wm,c[4]+nx*w1,c[5]+ny*w1);
    ctx.lineTo(c[4]-nx*w1,c[5]-ny*w1);ctx.quadraticCurveTo(c[2]-nx*wm,c[3]-ny*wm,c[0]-nx*w0,c[1]-ny*w0);ctx.closePath();}
  function draw(now){if(!ctx)return;const T=(now-t0)/1000,still=RM();
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
    // depth: drifting dust with parallax
    for(const d of dust){const x=((d.x*W+cam.x*d.d)%W+W)%W,y=((d.y*H+cam.y*d.d)%H+H)%H;
      ctx.globalAlpha=d.a*(still?1:.75+.25*Math.sin(T*.6+d.x*20));ctx.fillStyle='#c8caff';ctx.fillRect(x,y,d.r,d.r);}
    ctx.globalAlpha=1;if(!nodes.length)return;
    const F=focusSet(),q=query&&matches.size;
    // ease per-node emphasis so highlight changes fade instead of snapping
    for(const n of nodes){const tv=shown(n)?1:0,td=F?(F.has(n)?1:.1):q?(matches.has(n)?1:.14):1;
      const k=still?1:.18;n.vis+=(tv-n.vis)*k;n.dim+=(td-n.dim)*k;
      if(n.appear<1&&(now-tBuild)/16>n.born*.5)n.appear=Math.min(1,n.appear+.04);}
    ctx.save();ctx.translate(W/2+cam.x,H/2+cam.y);ctx.scale(cam.z,cam.z);
    // edges: tapered, additive, opacity by weight
    ctx.globalCompositeOperation='lighter';
    for(const e of edges){const a0=Math.min(e.s.vis,e.t.vis)*Math.min(e.s.appear,e.t.appear);if(a0<.02)continue;
      const on=F&&F.has(e.s)&&F.has(e.t)&&(e.s===(hover||sel)||e.t===(hover||sel));
      const em=F?(on?1:.06):q?((matches.has(e.s)||matches.has(e.t))?.7:.08):1;
      const wn=e.w/maxW,c=curve(e);
      const base=e.kind==='has'?.10+wn*.42:.06+wn*.3;
      const w0=(e.kind==='has'?1.1+wn*3.2:.6+wn*1.6)*(on?1.5:1)/Math.max(.6,cam.z*.8),w1=Math.max(.25,w0*.18);
      ctx.globalAlpha=Math.min(.95,base*em*(on?2.2:1))*a0;
      if(e.s.h!==e.t.h){const gr=ctx.createLinearGradient(c[0],c[1],c[4],c[5]);gr.addColorStop(0,hsl(e.s.h,85,64));gr.addColorStop(1,hsl(e.t.h,85,64));ctx.fillStyle=gr;}
      else ctx.fillStyle=hsl(e.s.h,85,64);
      edgePath(c,w0,w1);ctx.fill();}
    // particles flowing hub -> concept along strong links
    if(!still){for(const e of edges){if(!e.parts)continue;const a0=Math.min(e.s.vis,e.t.vis,e.s.appear,e.t.appear);if(a0<.3)continue;
      const on=F&&F.has(e.s)&&F.has(e.t);if(F&&!on)continue;const c=curve(e),sp=sprite(e.t.h).dot;
      for(const p of e.parts){const t=(T*p.sp+p.o)%1,[x,y]=qpt(c,t),s=(on?9:6)/Math.max(.7,cam.z*.9);
        ctx.globalAlpha=a0*(on?.95:.55)*Math.sin(t*Math.PI);ctx.drawImage(sp,x-s/2,y-s/2,s,s);}}}
    // halos
    for(const n of nodes){const a0=n.vis*n.appear*n.dim;if(a0<.02)continue;
      const br=still?1:1+.07*Math.sin(T*1.3+n.ph),hot=n===hover||n===sel;
      const R=n.r*(n.proj?4.2:3.2)*br*(hot?1.35:1)*(q&&matches.has(n)?1.3:1);
      ctx.globalAlpha=a0*(n.proj?.9:.6)*(hot?1.2:1);ctx.drawImage(sprite(n.h).glow,n.x-R,n.y-R,R*2,R*2);}
    ctx.globalCompositeOperation='source-over';
    // orbs
    for(const n of nodes){const a0=n.vis*n.appear;if(a0<.02)continue;const ease=1-Math.pow(1-n.appear,3);
      const r=n.r*ease*(n===hover?1.12:1);ctx.globalAlpha=a0*(n.dim<.5&&n.proj?.1:.18+.82*n.dim);
      ctx.drawImage(sprite(n.h).orb,n.x-r,n.y-r,r*2,r*2);
      if(n.proj){// hub rings: a steady ring and a slowly orbiting arc
        ctx.lineWidth=1.4/cam.z;ctx.strokeStyle=hsl(n.h,90,80,.45*n.dim);ctx.beginPath();ctx.arc(n.x,n.y,r+5,0,6.2832);ctx.stroke();
        const s0=still?0:T*.5+n.ph;ctx.lineWidth=2/cam.z;ctx.strokeStyle=hsl(n.h,95,82,.85*n.dim);ctx.beginPath();ctx.arc(n.x,n.y,r+9,s0,s0+1.4);ctx.stroke();
        ctx.beginPath();ctx.arc(n.x,n.y,r+9,s0+3.14,s0+3.6);ctx.stroke();}
      if(q&&matches.has(n)){const pr=r+6+(still?0:Math.sin(T*3)*2);ctx.lineWidth=2/cam.z;ctx.strokeStyle='rgba(255,255,255,.8)';ctx.beginPath();ctx.arc(n.x,n.y,pr,0,6.2832);ctx.stroke();}
      if(n===sel||(n===kbNode()&&document.activeElement===cv)){ctx.lineWidth=2/cam.z;ctx.setLineDash([4/cam.z,3/cam.z]);ctx.strokeStyle='rgba(255,255,255,.9)';
        ctx.beginPath();ctx.arc(n.x,n.y,r+(n.proj?14:6),0,6.2832);ctx.stroke();ctx.setLineDash([]);}}
    ctx.restore();ctx.globalAlpha=1;labels(F,q);}
  // labels in screen space, greedy placement by priority so they never collide
  function labels(F,q){const placed=[],f=hover||sel,cand=[];
    // hub orbs count as occupied, so concept labels never sit on top of a project
    for(const n of nodes)if(n.proj&&n.vis>.5){const p=toScreen(n.x,n.y),r=n.r*cam.z;placed.push([p.x-r,p.y-r,p.x+r,p.y+r]);}
    for(const n of nodes){if(n.vis*n.appear<.5)continue;const s=toScreen(n.x,n.y);if(s.x<-80||s.y<-40||s.x>W+80||s.y>H+40)continue;
      let pr=n.proj?600+n.weight:n.weight+(n.r*cam.z>9?200:0);
      if(F){if(n===f)pr=1e6;else if(F.has(n))pr+=3000;else pr-=5000;}
      if(q&&matches.has(n))pr+=4000;else if(q)pr-=3000;
      cand.push({n,s,pr});}
    cand.sort((a,b)=>b.pr-a.pr);let budget=Math.max(10,Math.round(W*H/9000));
    ctx.textAlign='center';ctx.textBaseline='middle';
    for(const c of cand){if(budget<=0&&c.pr<3000)break;const n=c.n,big=n.proj,hot=n===f;
      if(c.pr<0&&!hot)continue;
      const fs=big?13:hot?12.5:11.5;ctx.font=`${big||hot?600:500} ${fs}px ${FONT}`;
      const tw=(n['tw'+fs]??=ctx.measureText(n.label).width),pad=big?9:5,bw=tw+pad*2,bh=big?22:17;
      const y=c.s.y+n.r*cam.z+(big?24:12)+bh/2-6,x=c.s.x;const rc=[x-bw/2,y-bh/2,x+bw/2,y+bh/2];
      if(!hot&&placed.some(p=>rc[0]<p[2]+2&&rc[2]>p[0]-2&&rc[1]<p[3]+1&&rc[3]>p[1]-1))continue;
      placed.push(rc);budget--;
      const a=Math.min(1,n.vis*n.appear)*(F&&!F.has(n)?.35:1);ctx.globalAlpha=a;
      if(big||hot){ctx.fillStyle=big?'rgba(12,13,18,.82)':'rgba(12,13,18,.9)';ctx.strokeStyle=hsl(n.h,90,70,big?.45:.6);ctx.lineWidth=1;
        rr(rc[0],rc[1],bw,bh,bh/2);ctx.fill();ctx.stroke();ctx.fillStyle=big?'#f4f4f6':hsl(n.h,60,90);ctx.fillText(n.label,x,y+.5);}
      else{ctx.lineWidth=3.5;ctx.strokeStyle='rgba(8,9,12,.85)';ctx.lineJoin='round';ctx.strokeText(n.label,x,y);ctx.fillStyle=hsl(n.h,45,84);ctx.fillText(n.label,x,y);}}
    ctx.globalAlpha=1;}
  function rr(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}

  // ── frame loop: runs while visible and something is moving
  function viewOn(){return !document.hidden&&cv.offsetParent!==null;}
  function kick(){if(running||!loaded)return;running=true;raf=requestAnimationFrame(frame);}
  function frame(now){if(!viewOn()){running=false;return;}
    if(alpha>0)tick();
    const k=RM()?1:.2;cam.x+=(tgt.x-cam.x)*k;cam.y+=(tgt.y-cam.y)*k;cam.z+=(tgt.z-cam.z)*k;
    if(!userCam&&alpha>.05&&!sel)fit(null,false);
    draw(now);
    const camMoving=Math.abs(tgt.x-cam.x)+Math.abs(tgt.y-cam.y)>.3||Math.abs(tgt.z-cam.z)>.001;
    if(RM()&&alpha===0&&!camMoving&&!drag){running=false;return;}
    raf=requestAnimationFrame(frame);}

  // ── hit testing
  function pick(px,py){const w=toWorld(px,py);let best=null,bd=1e9;
    for(const n of nodes){if(n.vis<.5)continue;const d=Math.hypot(n.x-w.x,n.y-w.y),hit=n.r+Math.max(4,8/cam.z);if(d<hit&&d-n.r<bd){bd=d-n.r;best=n;}}return best;}

  // ── tooltip
  function rel(ms){if(!ms)return'';const d=Date.now()-ms;return d<6e4?'just now':ago(d)+' ago';}
  function projOf(n){return [...nb(n)].filter(m=>m.proj).map(m=>({m,w:(edges.find(e=>e.s===m&&e.t===n)||{}).w||0})).sort((a,b)=>b.w-a.w);}
  function showTip(n,px,py){if(!n){tip.style.opacity=0;tip.setAttribute('aria-hidden','true');return;}
    let body;
    if(n.proj){const cs=[...nb(n)].filter(m=>!m.proj).sort((a,b)=>b.weight-a.weight);
      body=`<div class="gt-k">Project</div><b class="gt-t">${esc(n.label)}</b><div class="gt-m">${n.weight.toLocaleString()} memories · ${cs.length} concepts${n.last?' · active '+rel(n.last):''}</div>`+
        (cs.length?`<div class="gt-l">${cs.slice(0,4).map(m=>`<span class="gt-c" style="--h:${m.h}">${esc(m.label)}</span>`).join('')}</div>`:'')+`<div class="gt-h">Click to focus this cluster</div>`;}
    else{const ps=projOf(n),rc=[...nb(n)].filter(m=>!m.proj).length;
      body=`<div class="gt-k">Concept</div><b class="gt-t">${esc(n.label)}</b><div class="gt-m">${n.weight.toLocaleString()} ${n.weight===1?'memory':'memories'}${n.last?' · last '+rel(n.last):''}${rc?' · '+rc+' related':''}</div>`+
        (ps.length?`<div class="gt-p">${ps.slice(0,4).map(({m,w})=>`<div><span class="sw" style="--h:${m.h}"></span>${esc(m.label)}<i>${w}</i></div>`).join('')}${ps.length>4?`<div class="muted">+${ps.length-4} more</div>`:''}</div>`:'')+`<div class="gt-h">Click to read its memories</div>`;}
    tip.innerHTML=body;tip.style.opacity=1;tip.removeAttribute('aria-hidden');
    const tw=tip.offsetWidth,th=tip.offsetHeight;let x=px+16,y=py+14;if(x+tw>W-8)x=px-tw-16;if(y+th>H-8)y=py-th-14;
    tip.style.transform=`translate(${Math.max(8,x)}px,${Math.max(8,y)}px)`;}

  // ── selection + side panel
  let selTok=0;
  function select(n,opts={}){sel=n||null;hover=null;showTip(null);syncLegend();
    if(!n){kbIdx=-1;closePanel();if(!opts.keepCam){userCam=false;fit(null,false);}kick();return;}
    kbIdx=nodes.order.indexOf(n);
    openPanel(n);
    const cluster=()=>{const s=new Set(nb(n));s.add(n);return s;};
    if(n.proj){fit(cluster(),false);userCam=true;
      // bring in this project's own top topics, not only the ones in the global top list
      expand('project',n.label).then(()=>{if(sel!==n)return;openPanel(n,{quiet:true});fit(cluster(),false);setTimeout(()=>{if(sel===n&&userCam)fit(cluster(),false);},700);});}
    else if(!opts.keepCam){const p=toScreen(n.x,n.y);
      if(p.x<40||p.y<70||p.x>W-40||p.y>H-40||tgt.z<.9){const z=Math.max(tgt.z,1.2);tgt={z,x:-n.x*z,y:-n.y*z};userCam=true;}}
    announce((n.proj?'Project ':'Concept ')+n.label+', '+n.weight+' memories');kick();}
  function closePanel(){panel.innerHTML='';renderList();panel.scrollTop=0;}
  function memRow(o){return `<button class="gp-row" data-obs="${Number(o.id)}"><span class="gr-t">${esc(o.title||'(untitled)')}</span><span class="gr-m"><span class="sw" style="--h:${hueFor(o.project)}"></span>${esc(o.project)}${o.created_at?' · '+esc(String(o.created_at).slice(0,10)):''}</span></button>`;}
  function recentFor(n){const L=layers.find(L=>L.focus===n.id);if(!L)return '<div class="sk" style="height:38px"></div><div class="sk" style="height:38px"></div>';
    const r=L.recent||[];return r.length?r.map(memRow).join(''):'<div class="muted" style="font-size:12px">No titled memories yet.</div>';}
  function openPanel(n,opts0={}){const tok=++selTok;const ps=n.proj?[]:projOf(n);
    const related=[...nb(n)].filter(m=>!m.proj).sort((a,b)=>b.weight-a.weight);
    const chips=list=>list.slice(0,14).map(m=>`<button class="gchip" data-id="${escAttr(m.id)}" style="--h:${m.h}"><span class="sw"></span>${esc(m.label)}<i>${m.weight}</i></button>`).join('');
    const maxPw=Math.max(1,...ps.map(p=>p.w));
    panel.innerHTML=`<button class="gp-back" data-act="back">${icon('arrow-left','sm')}All projects</button>
      <div class="gp-head" style="--h:${n.h}"><span class="gp-orb"></span><div class="gp-tt"><div class="gt-k">${n.proj?'Project':'Concept'}</div><h3>${esc(n.label)}</h3></div>
        <button class="gp-x" aria-label="Close details">${icon('x')}</button></div>
      <div class="gp-stats"><div><b>${n.weight.toLocaleString()}</b><span>${n.weight===1?'memory':'memories'}</span></div>
        <div><b>${n.proj?related.length:(n.projects||ps.length)}</b><span>${n.proj?'topics shown':((n.projects||ps.length)===1?'project':'projects')}</span></div>
        <div><b>${n.last?ago(Math.max(0,Date.now()-n.last)):'—'}</b><span>since last</span></div></div>
      ${!n.proj&&ps.length?`<div class="eyebrow">Projects</div><div class="gp-bars">${ps.map(({m,w})=>`<button class="gp-bar" data-id="${escAttr(m.id)}" style="--h:${m.h}"><span class="gb-l">${esc(m.label)}</span><span class="gb-t"><span style="width:${Math.max(6,w/maxPw*100)}%"></span></span><i>${w}</i></button>`).join('')}</div>`:''}
      ${related.length?`<div class="eyebrow">${n.proj?'Top concepts':'Linked concepts'}</div><div class="gp-chips">${chips(related)}</div>`:''}
      ${n.proj?`<div class="eyebrow">Recent memories</div><div class="gp-mem" id="gpMem">${recentFor(n)}</div>
         <div class="gp-act"><button class="btn" data-act="isolate">${icon('eye')}${isolate===n.group?'Show all projects':'Show only this cluster'}</button></div>`:
        `<div class="eyebrow">Recent memories</div><div class="gp-mem" id="gpMem"><div class="sk" style="height:38px"></div><div class="sk" style="height:38px"></div><div class="sk" style="height:38px"></div></div>
         <div class="gp-act"><button class="btn pri" data-act="memory">${icon('database')}Open in Memory</button></div>`}`;
    panel.scrollTop=0;sideLabel();if(W<=700&&!opts0.quiet)openSheet(true);
    if(!n.proj)api('/api/search?concept='+encodeURIComponent(n.label)+'&limit=6').then(r=>{if(tok!==selTok)return;const el=$('#gpMem');if(!el)return;
      const rows=r.results||[];el.innerHTML=rows.length?rows.map(memRow).join('')+(r.total>rows.length?`<div class="muted gr-more">${(r.total-rows.length).toLocaleString()} more in Memory</div>`:''):'<div class="muted" style="font-size:12px">No live memories carry this concept.</div>';})
      .catch(e=>{if(tok===selTok){const el=$('#gpMem');if(el)el.innerHTML=`<div class="muted" style="font-size:12px">Could not load memories: ${esc(e.message)}</div>`;}});}
  panel.addEventListener('click',e=>{const t=e.target;
    if(t.closest('.gp-x')||t.closest('[data-act="back"]')){select(null,{keepCam:!!t.closest('[data-act="back"]')});cv.focus({preventScroll:true});return;}
    const idb=t.closest('[data-id]');if(idb){const m=byId.get(idb.dataset.id);if(m)select(m);return;}
    const ob=t.closest('[data-obs]');if(ob){openObs(Number(ob.dataset.obs));return;}
    const act=t.closest('[data-act]');if(!act||!sel)return;
    if(act.dataset.act==='memory'){const c=sel.label;showView('mem');setTimeout(()=>searchConcept(c),0);}
    if(act.dataset.act==='isolate'){isolate=isolate===sel.group?null:sel.group;syncLegend();openPanel(sel,{quiet:true});reheat(.2);const s=new Set(nb(sel));s.add(sel);fit(s,false);}});
  function announce(s){if(live)live.textContent=s;}

  // ── pointer: drag nodes, pan, pinch, click
  const ptrs=new Map();let drag=null,pan=null,pinch=null,downAt=null,moved=false;
  cv.addEventListener('pointerdown',e=>{if(!loaded||!nodes.length)return;cv.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,{x:e.offsetX,y:e.offsetY});
    moved=false;downAt={x:e.offsetX,y:e.offsetY};
    if(ptrs.size===2){const[a,b]=[...ptrs.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),z:tgt.z};if(drag){drag.fixed=false;drag=null;}pan=null;return;}
    const n=pick(e.offsetX,e.offsetY);
    if(n){drag=n;n.fixed=true;n.fx=n.x;n.fy=n.y;}else pan={x:e.offsetX,y:e.offsetY,cx:tgt.x,cy:tgt.y};});
  cv.addEventListener('pointermove',e=>{const px=e.offsetX,py=e.offsetY;
    if(ptrs.has(e.pointerId))ptrs.set(e.pointerId,{x:px,y:py});
    if(downAt&&Math.hypot(px-downAt.x,py-downAt.y)>4)moved=true;
    if(pinch&&ptrs.size===2){const[a,b]=[...ptrs.values()];const d=Math.hypot(a.x-b.x,a.y-b.y);const z=clampZ(pinch.z*d/pinch.d);zoomAt((a.x+b.x)/2,(a.y+b.y)/2,z/tgt.z);return;}
    if(drag&&moved){const w=toWorld(px,py);drag.fx=w.x;drag.fy=w.y;reheat(.25);showTip(null);cv.style.cursor='grabbing';return;}
    if(pan){if(moved){tgt.x=pan.cx+(px-pan.x);tgt.y=pan.cy+(py-pan.y);cam.x=tgt.x;cam.y=tgt.y;userCam=true;cv.style.cursor='grabbing';kick();}return;}
    if(e.pointerType==='touch')return;
    const n=pick(px,py);if(n!==hover){hover=n;kick();}
    cv.style.cursor=n?'pointer':'grab';showTip(n,px,py);});
  function up(e){ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null;
    if(drag){const n=drag;drag=null;n.fixed=false;if(!moved)select(n===sel&&!n.proj?null:n,{});else reheat(.15);}
    else if(pan){pan=null;if(!moved&&e.type==='pointerup')select(null,{keepCam:true});}
    downAt=null;cv.style.cursor='grab';}
  cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
  cv.addEventListener('pointerleave',()=>{if(!drag&&!pan){hover=null;showTip(null);kick();}});
  cv.addEventListener('dblclick',e=>{const n=pick(e.offsetX,e.offsetY);if(!n){userCam=false;fit(null,false);}});
  cv.addEventListener('wheel',e=>{if(!nodes.length)return;e.preventDefault();const dy=e.deltaMode===1?e.deltaY*16:e.deltaY;
    zoomAt(e.offsetX,e.offsetY,Math.exp(-dy*(e.ctrlKey?.01:.0018)));showTip(null);},{passive:false});

  // ── keyboard: arrows pan, +/- zoom, 0 fits, N / Shift+N walk nodes, Enter opens, Esc clears
  function kbNode(){return kbIdx>=0&&nodes.order?nodes.order[kbIdx]:null;}
  cv.addEventListener('keydown',e=>{if(!nodes.length)return;const k=e.key;let h=true;
    if(k==='ArrowLeft'){tgt.x+=60;userCam=true;}else if(k==='ArrowRight'){tgt.x-=60;userCam=true;}
    else if(k==='ArrowUp'){tgt.y+=60;userCam=true;}else if(k==='ArrowDown'){tgt.y-=60;userCam=true;}
    else if(k==='+'||k==='='){zoomAt(W/2,H/2,1.25);}else if(k==='-'||k==='_'){zoomAt(W/2,H/2,.8);}
    else if(k==='0'){userCam=false;fit(null,false);}
    else if(k==='n'||k==='N'){const L=nodes.order.filter(shown);if(!L.length)return;let i=L.indexOf(kbNode());i=(i+(e.shiftKey?-1:1)+L.length)%L.length;
      const n=L[i];kbIdx=nodes.order.indexOf(n);hover=n;const p=toScreen(n.x,n.y);showTip(n,p.x,p.y);
      if(p.x<40||p.y<40||p.x>W-40||p.y>H-40){tgt={...tgt,x:-n.x*tgt.z,y:-n.y*tgt.z};userCam=true;}announce((n.proj?'Project ':'Concept ')+n.label+', '+n.weight+' memories. Enter to open.');}
    else if(k==='Enter'||k===' '){const n=kbNode();if(n)select(n);}
    else if(k==='Escape'){if(sel)select(null);else{hover=null;showTip(null);}}
    else if(k==='/'){$('#gsearch').focus();}
    else h=false;
    if(h){e.preventDefault();if(RM())cam={...tgt};kick();}});
  cv.addEventListener('focus',()=>kick());cv.addEventListener('blur',()=>{if(hover&&!drag){hover=null;showTip(null);kick();}});
  wrap.addEventListener('keydown',e=>{if(e.key==='Escape'&&e.target!==cv&&sel){select(null);cv.focus({preventScroll:true});}});

  // ── search: highlight matches, Enter flies to the best one
  const sIn=$('#gsearch'),sCount=$('#gcount');
  function filter(s){query=(s||'').trim().toLowerCase();matches=new Set(query?nodes.filter(n=>shown(n)&&n.label.toLowerCase().includes(query)):[]);
    if(sCount){sCount.textContent=query?(matches.size?matches.size+' on map':'none on map'):'';sCount.classList.toggle('none',!!query&&!matches.size);}
    kick();}
  // store-wide suggestions: any topic in memory, not only those on screen
  const sug=$('#gsugg');let sugList=[],sugAct=-1,sugT=0,sugTok=0;
  function renderSug(){if(!sug)return;if(!sugList.length||!query){sug.hidden=true;sIn.setAttribute('aria-expanded','false');return;}
    sug.innerHTML=`<div class="gs-h">Topics in memory</div>`+sugList.map((r,i)=>{const on=byId.has('c:'+r.concept);
      return `<button class="gs-row${i===sugAct?' act':''}" role="option" id="gs-${i}" aria-selected="${i===sugAct}" data-c="${escAttr(r.concept)}"><span class="sw" style="--h:${hueFor(r.project)}"></span><span class="gs-t">${esc(r.concept)}</span><span class="gs-m">${r.count.toLocaleString()}${on?'':' · load'}</span></button>`;}).join('');
    sug.hidden=false;sIn.setAttribute('aria-expanded','true');if(sugAct>=0)sIn.setAttribute('aria-activedescendant','gs-'+sugAct);else sIn.removeAttribute('aria-activedescendant');}
  function closeSug(){sugList=[];sugAct=-1;renderSug();}
  async function pickConcept(c){closeSug();sIn.value=c;filter(c);
    const n=await expand('concept',c);if(n){select(n);filter('');sIn.value='';}}
  sIn.addEventListener('input',()=>{filter(sIn.value);clearTimeout(sugT);const q=query,tok=++sugTok;
    if(!q){closeSug();return;}
    sugT=setTimeout(async()=>{let r;try{r=await api('/api/graph/search?q='+encodeURIComponent(q));}catch{return;}if(tok!==sugTok)return;sugList=(r.results||[]).slice(0,8);sugAct=-1;renderSug();},160);});
  sIn.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(!sugList.length)return;e.preventDefault();sugAct=(sugAct+(e.key==='ArrowDown'?1:-1)+sugList.length)%sugList.length;renderSug();}
    else if(e.key==='Enter'){e.preventDefault();if(sugAct>=0&&sugList[sugAct])return pickConcept(sugList[sugAct].concept);
      const best=[...matches].sort((a,b)=>(b.label.toLowerCase()===query)-(a.label.toLowerCase()===query)||b.weight-a.weight)[0];
      if(best){closeSug();select(best);}else if(sugList[0])pickConcept(sugList[0].concept);}
    else if(e.key==='Escape'){sIn.value='';filter('');closeSug();cv.focus({preventScroll:true});}});
  sIn.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==sIn)closeSug();},150));
  if(sug)sug.addEventListener('pointerdown',e=>{const b=e.target.closest('[data-c]');if(b){e.preventDefault();pickConcept(b.dataset.c);}});

  // ── controls
  function reset(){sIn.value='';filter('');closeSug();isolate=null;showConcepts=true;syncConcepts();select(null);
    if(layers.length){layers=[];compose();header();}userCam=false;reheat(.3);fit(null,false);}
  // topic density: how many of the store's topics the overview shows
  const dens=$('#gdens');
  if(dens){dens.value=DENS.indexOf(limit);dens.addEventListener('input',()=>{const v=DENS[+dens.value];const o=$('#gdensv');if(o)o.textContent=v;});
    dens.addEventListener('change',()=>{const v=DENS[+dens.value];if(v!==limit)setLimit(v);});}
  function syncConcepts(){const b=$('#gToggle');if(b){b.setAttribute('aria-pressed',String(showConcepts));b.innerHTML=icon('layers')+(showConcepts?'Hide concepts':'Show concepts');}}
  function toggleConcepts(){showConcepts=!showConcepts;syncConcepts();if(sel&&!sel.proj&&!showConcepts)select(null);filter(sIn.value);reheat(.3);if(!userCam)fit(null,false);}
  $('#gzoom').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.z==='in')zoomAt(W/2,H/2,1.3);else if(b.dataset.z==='out')zoomAt(W/2,H/2,1/1.3);else{userCam=false;fit(sel&&sel.proj?new Set([sel,...nb(sel)]):null,false);}});
  $('#gReset').addEventListener('click',reset);$('#gToggle').addEventListener('click',toggleConcepts);
  new ResizeObserver(()=>{if(loaded&&size()){if(!userCam)fit(sel&&sel.proj?new Set([sel,...nb(sel)]):null,true);draw(performance.now());kick();}}).observe(stage);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)kick();});
  REDUCE.addEventListener?.('change',()=>{for(const n of nodes)n.appear=1;kick();});
  // where(label): a node's position in canvas pixels (for automated UI checks)
  const where=label=>{const n=nodes.find(m=>m.label===label);if(!n)return null;const p=toScreen(n.x,n.y);return{x:p.x,y:p.y,r:n.r*cam.z};};
  return{ensure,filter,reset,toggleConcepts,where};
})();

// ═══════════════════════ Boot ═══════════════════════
hydrateIcons();
stagger([...$('.view.on').children],45);
refresh();loadHealth();
setInterval(()=>{if($('.view.on')?.dataset.view==='dash'||document.visibilityState==='visible')refresh();},15000);
setInterval(()=>{if(document.visibilityState==='visible')loadHealth();},120000);
if(location.hash){const v=location.hash.slice(1);if(v&&v!=='dash')setTimeout(()=>showView(v),0);}
