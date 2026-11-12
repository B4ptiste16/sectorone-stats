// SectorOne stats: collects downloads (GitHub), accounts + usage + ratings
// (Firebase) and optional repo traffic, then writes ONE static page with charts.
//
//   node build.cjs            -> site/index.html            (public: ENCRYPTED, no emails, no comments)
//   node build.cjs --serve    -> same data, opens http://localhost:5199 (PRIVATE: emails + comments)
//   STATS_DEMO=1 node build.cjs   made-up data, to preview the design
//
// Credentials (never committed):
//   FIREBASE_SERVICE_ACCOUNT  JSON text (GitHub Actions secret) or file ~/.sectorone-stats-ro.json
//   STATS_GH_TOKEN            optional PAT with push access to the repo, for traffic graphs
//   SHOW_COMMENTS=1           also publish rating comments (anonymous) on the public page
//   SHOW_EMAILS=1             show real emails instead of "User N" (still only inside the encrypted page)
//   site/public.json          NOT encrypted, on purpose: only { tracks, live, updated }, for the count on sectorone.web.app
//   STATS_PASSWORD            secret, or file ~/.sectorone-stats-password.txt. Encrypts the page and
//                             data/history.enc.json. Without it the public build holds NO data at all.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');

const REPO = process.env.STATS_REPO || 'B4ptiste16/SectorOne';
const SERVE = process.argv.includes('--serve');
const PRIVATE = SERVE;
const DEMO = !!process.env.STATS_DEMO;
const HISTORY = path.join(__dirname, 'data', 'history.enc.json');
const PW_FILE = path.join(os.homedir(), '.sectorone-stats-password.txt');
const password = () => process.env.STATS_PASSWORD || (fs.existsSync(PW_FILE) ? fs.readFileSync(PW_FILE, 'utf8').trim() : '');
// AES-256-GCM with a PBKDF2 key: the same format is opened by WebCrypto in the page.
const ITER = 600000;
function seal(text, pw) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.pbkdf2Sync(pw, salt, ITER, 32, 'sha256'), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  return { iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function unseal(b, pw) {
  const all = Buffer.from(b.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.pbkdf2Sync(pw, Buffer.from(b.salt, 'base64'), b.iter, 32, 'sha256'), Buffer.from(b.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
}
const OUT = path.join(__dirname, 'site');
// the launch gift (ac-track-forge src/account/config.ts GIFT_PREMIUM_BEFORE): accounts created before it have Premium free
const GIFT_BEFORE = Date.parse('2026-11-11T19:45:00Z');
const day = (d) => new Date(d).toISOString().slice(0, 10);

// ---------- collect ----------
async function gh(url, token) {
  const r = await fetch('https://api.github.com/' + url, { headers: { 'User-Agent': 'sectorone-stats', Accept: 'application/vnd.github+json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${url}`);
  return r.json();
}
async function downloads() {
  const rels = await gh(`repos/${REPO}/releases?per_page=100`, process.env.GITHUB_TOKEN);
  return rels.map((r) => ({ tag: r.tag_name, date: r.published_at.slice(0, 10), n: r.assets.filter((a) => a.name.endsWith('.exe')).reduce((s, a) => s + a.download_count, 0) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
async function traffic() {
  const t = process.env.STATS_GH_TOKEN;
  if (!t) return null;
  const [v, c, refs] = await Promise.all([gh(`repos/${REPO}/traffic/views`, t), gh(`repos/${REPO}/traffic/clones`, t), gh(`repos/${REPO}/traffic/popular/referrers`, t)]);
  return { views: v.views.map((x) => [day(x.timestamp), x.count, x.uniques]), clones: c.clones.map((x) => [day(x.timestamp), x.count, x.uniques]), refs: refs.map((r) => [r.referrer, r.uniques]), totals: { views: v.count, uniques: v.uniques, clones: c.count } };
}
function admin() {
  const mod = [path.join(__dirname, 'node_modules', 'firebase-admin'), path.join(os.homedir(), 'Documents', 'ac-track-forge', 'functions', 'node_modules', 'firebase-admin')].find((p) => fs.existsSync(p));
  if (!mod) throw new Error('firebase-admin not installed (npm install)');
  const a = require(mod);
  const keyFile = path.join(os.homedir(), '.sectorone-stats-ro.json');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '');
  if (!raw) throw new Error('No Firebase service account (secret FIREBASE_SERVICE_ACCOUNT)');
  if (!a.apps.length) a.initializeApp({ credential: a.credential.cert(JSON.parse(raw)) });
  return a;
}
async function firebase() {
  const a = admin(), db = a.firestore();
  const users = []; let tok;
  do { const r = await a.auth().listUsers(1000, tok); users.push(...r.users); tok = r.pageToken; } while (tok);
  const [u, f, p] = await Promise.all([db.collection('usage').get(), db.collection('feedback').orderBy('createdAt', 'desc').limit(500).get(), db.collection('users').get()]);
  const ts = (t) => (t && t.toDate ? t.toDate().toISOString() : null);
  const order = users.map((x) => ({ uid: x.uid, email: x.email || '', at: new Date(x.metadata.creationTime).getTime() })).sort((p, q) => p.at - q.at);
  const num = new Map(order.map((x, i) => [x.uid, i + 1]));
  // THE PLAN of each account. Paid = what the Stripe webhook wrote (premium: bought once, deluxe: monthly).
  // The launch gift is not in the database (the app gives it to accounts created before GIFT_BEFORE),
  // so gifted accounts are told apart by their creation date and never counted as subscriptions.
  const prof = new Map(p.docs.map((d) => [d.id, d]));
  const planOf = (uid, at) => {
    const d = prof.get(uid);
    if (d && d.get('deluxe') === true) return { plan: 'monthly', paidAt: ts(d.get('deluxeSince')) };
    if (d && d.get('premium') === true) return { plan: 'once', paidAt: ts(d.get('premiumSince')) };
    return { plan: at < GIFT_BEFORE ? 'gift' : 'free', paidAt: null };
  };
  const plans = new Map(order.map((x) => [x.uid, planOf(x.uid, x.at)]));
  return {
    accounts: order.map((x) => ({ n: num.get(x.uid), email: x.email, at: new Date(x.at).toISOString(), ...plans.get(x.uid) })),
    usage: u.docs.map((d) => ({ n: num.get(d.id) || 0, plan: (plans.get(d.id) || { plan: 'free' }).plan, email: String(d.get('email') || ''), minutes: Number(d.get('minutes')) || 0, sessions: Number(d.get('sessions')) || 0, tracks: Number(d.get('tracksCreated')) || 0, exports: Number(d.get('exports')) || 0, version: String(d.get('version') || '?'), last: ts(d.get('lastSeen')) })),
    // newest first, so this keeps each account's latest rating: repeat posts can't skew the average
    ratings: f.docs.filter((d, i, all) => all.findIndex((o) => o.get('uid') === d.get('uid')) === i)
      .map((d) => ({ email: String(d.get('email') || ''), stars: Math.max(0, Math.min(5, Math.round(Number(d.get('stars')) || 0))), text: String(d.get('text') || ''), version: String(d.get('version') || '?'), at: ts(d.get('createdAt')) })),
  };
}
function demo() {
  const now = Date.now(), H = 3600e3, D = 24 * H, r = (a, b) => a + Math.random() * (b - a);
  const tags = ['v0.70.0', 'v0.72.0', 'v0.73.0', 'v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.2.1', 'v1.2.2'];
  const dl = tags.map((tag, i) => ({ tag, date: day(now - (tags.length - i) * 4 * D), n: Math.round(r(2, 40)) }));
  const accounts = Array.from({ length: 34 }, (_, i) => { const at = now - (34 - i) * 0.6 * D, pl = i < 12 ? 'gift' : i % 7 === 0 ? 'once' : i % 9 === 0 ? 'monthly' : 'free'; return { n: i + 1, email: `user${i + 1}@example.com`, at: new Date(at).toISOString(), plan: pl, paidAt: pl === 'once' || pl === 'monthly' ? new Date(at + r(0, 2) * D).toISOString() : null }; });
  const usage = accounts.slice(0, 26).map((a) => ({ n: a.n, plan: a.plan, email: a.email, minutes: Math.round(r(3, 600) ** 1), sessions: Math.round(r(1, 30)), tracks: Math.round(r(0, 12)), exports: Math.round(r(0, 14)), version: tags[Math.floor(r(3, 8))].slice(1), last: new Date(now - r(0, 9) * D).toISOString() }));
  const ratings = Array.from({ length: 12 }, () => ({ email: 'x@example.com', stars: [5, 5, 5, 4, 4, 3, 2][Math.floor(r(0, 7))], text: 'Great app, would love wet kerbs.', version: '1.2.2', at: new Date(now - r(0, 10) * D).toISOString() }));
  let acc = 0;
  const history = Array.from({ length: 21 }, (_, i) => { acc += Math.round(r(8, 50)); const m = Math.round(i * 90 + i * r(0, 30)); return { date: day(now - (20 - i) * D), downloads: acc, accounts: Math.round(i * 1.6), minutes: m, minPaid: Math.round(m * 0.2), minGift: Math.round(m * 0.5), minFree: m - Math.round(m * 0.2) - Math.round(m * 0.5), tracks: i * 3, exports: i * 4, sessions: i * 7, active: Math.round(r(3, 14)) }; });
  const events = Array.from({ length: 60 }, () => ({ at: new Date(now - r(0, 20) * D).toISOString(), tag: 'v1.2.2', n: Math.round(r(1, 7)) }));
  return { dl, fb: { accounts, usage, ratings }, tr: { views: Array.from({ length: 14 }, (_, i) => [day(now - (13 - i) * D), Math.round(r(20, 90)), Math.round(r(8, 40))]), clones: Array.from({ length: 14 }, (_, i) => [day(now - (13 - i) * D), Math.round(r(5, 40)), Math.round(r(2, 20))]), refs: [['Google', 31], ['reddit.com', 22], ['youtube.com', 9]], totals: { views: 700, uniques: 300, clones: 200 } }, history, events };
}

// ---------- history (committed to the repo so graphs grow over time) ----------
// A wrong password THROWS: the build fails rather than replacing the history with an empty one.
function readHistory(pw) {
  if (!pw || !fs.existsSync(HISTORY)) return { snapshots: [], events: [], counts: {} };
  return JSON.parse(unseal(JSON.parse(fs.readFileSync(HISTORY, 'utf8')), pw));
}
function updateHistory(h, dl, fb) {
  const first = !Object.keys(h.counts).length;
  for (const x of dl) {
    const was = h.counts[x.tag];
    if (!first && x.n > (was ?? 0)) h.events.unshift({ at: new Date().toISOString(), tag: x.tag, n: x.n - (was ?? 0) });
    h.counts[x.tag] = x.n;
  }
  const week = Date.now() - 7 * 864e5;
  const snap = { date: day(Date.now()), downloads: dl.reduce((s, x) => s + x.n, 0) };
  if (fb) Object.assign(snap, { accounts: fb.accounts.length, minutes: fb.usage.reduce((s, x) => s + x.minutes, 0), tracks: fb.usage.reduce((s, x) => s + x.tracks, 0), exports: fb.usage.reduce((s, x) => s + x.exports, 0), sessions: fb.usage.reduce((s, x) => s + x.sessions, 0), active: fb.usage.filter((x) => x.last && new Date(x.last) > week).length,
    // time in the app per plan, so a day's hours can be split between paying, gifted and free users
    minPaid: fb.usage.filter((x) => x.plan === 'once' || x.plan === 'monthly').reduce((s, x) => s + x.minutes, 0),
    minGift: fb.usage.filter((x) => x.plan === 'gift').reduce((s, x) => s + x.minutes, 0),
    minFree: fb.usage.filter((x) => x.plan === 'free').reduce((s, x) => s + x.minutes, 0) });
  h.snapshots = h.snapshots.filter((s) => s.date !== snap.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date));
  h.events = h.events.slice(0, 2000);
  return h;
}

// ---------- render ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render({ dl, fb, tr, history, events, errors }) {
  const pub = !PRIVATE;
  const who = (e, n) => ((pub && !process.env.SHOW_EMAILS) || !e ? `User ${n || '?'}` : e);
  const payload = {
    dl, history, events: events.slice(0, 1000), tr, errors,
    accounts: fb ? fb.accounts.map((x) => ({ at: x.at, plan: x.plan, paidAt: x.paidAt })) : null,
    usage: fb ? fb.usage.map((x) => ({ who: who(x.email, x.n), ...x, email: undefined })) : null,
    ratings: fb ? fb.ratings.map((x) => ({ who: who(x.email, 0), stars: x.stars, version: x.version, at: x.at, text: (PRIVATE || process.env.SHOW_COMMENTS) ? x.text : '' })) : null,
    updated: new Date().toISOString(), pub,
  };
  const json = JSON.stringify(payload);
  // Public page: only ciphertext. Local private view: plain, it never leaves this computer.
  const boot = PRIVATE ? 'P=' + json.replace(/</g, '\\u003c') + ',S=null' : 'P=null,S=' + JSON.stringify(seal(json, password()));
  const chart = fs.readFileSync(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>SectorOne stats</title>
<meta name=robots content="noindex"><meta name=referrer content="no-referrer">
<meta http-equiv=Content-Security-Policy content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<style>
:root{--bg:#0b0c10;--card:#15171d;--line:#23262f;--fg:#eceef2;--mut:#8a8f9c;--acc:#ffb45c;--c2:#5cc8ff;--c3:#7be0a4;--c4:#c792ff;--bad:#ff6b6b}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px 60px}
.wrap{max-width:1100px;margin:0 auto}header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:18px}
h1{font-size:20px;color:var(--acc);margin:0}.mut{color:var(--mut);font-size:13px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
.kpi{background:var(--card);border-radius:12px;padding:14px 16px}.kpi b{display:block;font-size:30px;line-height:1.1}.kpi span{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.kpi i{font-style:normal;font-size:12px;color:var(--c3);display:block;min-height:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
@media(max-width:480px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border-radius:12px;padding:16px;min-width:0}.card h2{font-size:14px;margin:0 0 2px}.card .mut{margin:0 0 10px}
.chart{position:relative;height:260px}.chart.tall{height:320px}.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:13px}th{color:var(--mut);font-weight:500;text-align:left;font-size:12px;text-transform:uppercase}
td,th{padding:6px 8px 6px 0;border-top:1px solid var(--line)}td.r,th.r{text-align:right}td.mut{color:var(--mut)}.err{color:var(--bad)}
.fb{border-top:1px solid var(--line);padding:8px 0}.st{color:#ffb21f}.off{color:#3a3d46}
.tabs{display:flex;gap:6px;margin-bottom:8px}.tabs button{background:#1e2129;border:0;color:var(--mut);padding:4px 10px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px}.tabs button.on{background:var(--acc);color:#111}
[hidden]{display:none!important}#lock{max-width:320px;margin:18vh auto;background:var(--card);border-radius:12px;padding:20px}#lock input{width:100%;padding:10px;margin:10px 0;background:#0b0c10;border:1px solid var(--line);border-radius:8px;color:var(--fg);font:inherit}#lock button{width:100%;padding:10px;background:var(--acc);border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}
</style>
<form id=lock hidden><h1>SectorOne stats</h1><input id=pw type=password autocomplete=current-password placeholder=Password aria-label=Password autofocus><button>Unlock</button><p id=lockErr class="mut err"></p></form>
<div class=wrap id=app hidden>
<header><h1>SectorOne stats</h1><span class=mut id=upd></span></header>
<div class=kpis id=kpis></div>
<div id=errs class="mut err"></div>
<p class=mut style="margin:0 0 12px">Every chart: <b>Per day</b> shows what happened each day, <b>Total</b> the running total. The number on each point is that day's value. Gifted Premium (launch accounts) is never counted as a subscription.</p>
<div class=grid>
 <div class=card><h2>Downloads</h2><p class=mut>installer downloads (GitHub counts auto-updates too)</p><div class=chart><canvas id=cDl></canvas></div></div>
 <div class=card><h2>Accounts created</h2><p class=mut>new sign-ups</p><div class=chart><canvas id=cAcc></canvas></div></div>
 <div class=card><h2>Download → account conversion</h2><p class=mut>accounts created ÷ downloads. Per day: that day only. Total: all accounts ÷ all downloads so far</p><div class=chart><canvas id=cConv></canvas></div></div>
 <div class=card><h2>Premium subscriptions</h2><p class=mut id=subSub>paid only: bought once (£11.99) and monthly (£1.99), gifts excluded</p><div class=chart><canvas id=cSub></canvas></div></div>
 <div class="card wide"><h2>Time spent in the app</h2><p class=mut>hours of active use, all users and split by plan (the split starts the day this version of the page went live)</p><div class="chart tall"><canvas id=cUse></canvas></div></div>
 <div class="card wide"><h2>Paying vs gifted vs free users</h2><p class=mut>how much each group uses the app</p><div style="overflow:auto"><table id=planT></table></div></div>
 <div class=card><h2>Active accounts</h2><p class=mut>accounts that used the app in the 7 days before each day</p><div class=chart><canvas id=cAct></canvas></div></div>
 <div class=card><h2>Tracks created and exported</h2><p class=mut>all accounts</p><div class=chart><canvas id=cTr></canvas></div></div>
 <div class=card id=trafficCard><h2>Releases page traffic</h2><p class=mut>GitHub, last 14 days</p><div class=chart><canvas id=cTraf></canvas></div></div>
 <div class=card><h2>App versions in use</h2><p class=mut>accounts by last version seen</p><div class=chart><canvas id=cVer></canvas></div></div>
 <div class=card><h2>Downloads per release</h2><div style="overflow:auto;max-height:300px"><table id=relT></table></div></div>
 <div class=card><h2>Ratings</h2><p class=mut id=ratingSub></p><table id=rateT></table></div>
 <div class="card wide"><h2>Accounts</h2><p class=mut id=usageSub></p><div style="overflow:auto"><table id=usageT></table></div></div>
 <div class="card wide"><h2>Ratings and comments</h2><div id=fbList></div></div>
</div>
</div>
<script>${chart}</script>
<script>
const ${boot};
const e=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(i)=>document.getElementById(i),C=getComputedStyle(document.documentElement),col=(n)=>C.getPropertyValue(n).trim();
const hm=(m)=>m>=60?Math.floor(m/60)+' h '+String(Math.round(m%60)).padStart(2,'0'):Math.round(m)+' min';
const DAY=864e5,dayOf=(t)=>new Date(t).toISOString().slice(0,10),today=dayOf(Date.now());
const span=(from)=>{const o=[];for(let t=Date.parse(from);dayOf(t)<=today;t+=DAY)o.push(dayOf(t));return o};
const short=(d)=>new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short'});
const cum=(a,base=0)=>{let r=base;return a.map(v=>r+=(v||0))};
const pct=(v)=>v==null?'':(Math.round(v*10)/10)+'%',hrs=(v)=>v==null?'':(v>=10?Math.round(v):Math.round(v*10)/10)+' h';
const GBP=(v)=>'£'+v.toFixed(2);
Chart.defaults.color=col('--mut');Chart.defaults.borderColor=col('--line');Chart.defaults.font.family='system-ui,sans-serif';
Chart.defaults.plugins.legend.labels.boxWidth=10;Chart.defaults.maintainAspectRatio=false;
// the number on each point: every point while they fit, otherwise every few (always the last)
Chart.register({id:'vals',afterDatasetsDraw(c){const ctx=c.ctx;ctx.save();ctx.font='600 11px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';
 c.data.datasets.forEach((ds,i)=>{const m=c.getDatasetMeta(i);if(m.hidden||ds.noVals)return;const n=m.data.length,step=Math.max(1,Math.ceil(n*30/Math.max(200,c.chartArea.width)));
  ctx.fillStyle=ds.borderColor;m.data.forEach((p,j)=>{const v=ds.data[j];if(v==null||isNaN(v))return;if(ds.skipZero&&v===0&&j!==n-1)return;if(j%step&&j!==n-1)return;ctx.fillText(ds.fmt?ds.fmt(v):v,p.x,p.y-6-(i%2)*11)})});ctx.restore()}});
const line=(label,data,c,x)=>Object.assign({label,data,borderColor:c,backgroundColor:c+'26',pointBackgroundColor:c,tension:.35,cubicInterpolationMode:'monotone',pointRadius:3,pointHoverRadius:5,borderWidth:2.2,fill:false,spanGaps:true},x||{});
// a chart with a Per day / Total switch. series: [{label,color,daily,total}] (total defaults to the running sum of daily)
function dual(id,days,series,o={}){const cv=$(id);if(!cv)return;const card=cv.closest('.card');let mode=o.start||'day',ch;
 const draw=()=>{if(ch)ch.destroy();const one=series.length===1;
  const ds=series.map(s=>line(s.label,mode==='day'?s.daily:(s.total||cum(s.daily)),s.color,{fill:one?'origin':false,fmt:o.fmt,skipZero:mode==='day'&&!o.keepZero,borderDash:s.dash}));
  ch=new Chart(cv,{type:'line',data:{labels:days.map(short),datasets:ds},options:{interaction:{mode:'index',intersect:false},layout:{padding:{top:18,right:22}},
   plugins:{legend:{display:!one},tooltip:{callbacks:{label:(t)=>t.dataset.label+': '+(o.fmt?o.fmt(t.raw):t.raw)}}},
   scales:{x:{ticks:{maxRotation:0,autoSkipPadding:12}},y:{beginAtZero:true,grace:'15%',ticks:{precision:o.prec??0,callback:(v)=>o.fmt?o.fmt(v):v}}}}});
  if(tabs)tabs.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===mode))};
 let tabs=null;if(!o.single){tabs=document.createElement('div');tabs.className='tabs';tabs.innerHTML='<button data-m=day>Per day</button><button data-m=total>Total</button>';
  tabs.onclick=(ev)=>{const m=ev.target.dataset.m;if(m&&m!==mode){mode=m;draw()}};card.insertBefore(tabs,card.querySelector('.chart'))}
 draw()}
function main(D){
$('app').hidden=false;
$('upd').textContent='Updated '+new Date(D.updated).toLocaleString('en-GB')+(D.pub?'':' · private view');
if(D.errors&&D.errors.length)$('errs').textContent=D.errors.join(' · ');
const H=(D.history.snapshots||D.history).filter(s=>s.date),last=H[H.length-1]||{},U=D.usage,A=D.accounts;
const totDl=D.dl.reduce((s,x)=>s+x.n,0);

// ---- downloads per day (logged by the hourly build; before that only the total is known)
const evDay={};[...D.events].forEach(x=>{const k=dayOf(x.at);evDay[k]=(evDay[k]||0)+x.n});
const dlStart=Object.keys(evDay).sort()[0]||today, dlDays=span(dlStart), dlDaily=dlDays.map(d=>evDay[d]||0);
const dlBase=totDl-dlDaily.reduce((s,v)=>s+v,0), dlTotal=cum(dlDaily,dlBase);
dual('cDl',dlDays,[{label:'Downloads',color:col('--acc'),daily:dlDaily,total:dlTotal}]);

const plans={once:'Premium (once)',monthly:'Premium (monthly)',gift:'Launch gift',free:'Free'};
const kp=[['Downloads',totDl,'']];
if(A){
 // ---- accounts created per day (from each account's creation date: the whole history)
 const accDay={};A.forEach(a=>{const k=dayOf(a.at);accDay[k]=(accDay[k]||0)+1});
 const accDays=span(Object.keys(accDay).sort()[0]||today),accDaily=accDays.map(d=>accDay[d]||0);
 dual('cAcc',accDays,[{label:'Accounts created',color:col('--c3'),daily:accDaily}]);
 // ---- conversion: accounts ÷ downloads, per day and overall so far
 const accAll=cum(accDays.map(d=>accDay[d]||0)),accAt=(d)=>{const i=accDays.indexOf(d);return i<0?(d<accDays[0]?0:accAll[accAll.length-1]):accAll[i]};
 const convDay=dlDays.map((d,i)=>dlDaily[i]?100*(accDay[d]||0)/dlDaily[i]:null),convTot=dlDays.map((d,i)=>dlTotal[i]?100*accAt(d)/dlTotal[i]:null);
 dual('cConv',dlDays,[{label:'Conversion',color:col('--c2'),daily:convDay,total:convTot}],{fmt:pct,keepZero:true});
 // ---- paid Premium (gifts excluded)
 const paid=A.filter(a=>(a.plan==='once'||a.plan==='monthly')),pDay={once:{},monthly:{}};
 paid.forEach(a=>{const k=dayOf(a.paidAt||a.at);pDay[a.plan][k]=(pDay[a.plan][k]||0)+1});
 const subDays=span([...paid.map(a=>dayOf(a.paidAt||a.at)),accDays[0]].sort()[0]);
 dual('cSub',subDays,[{label:'Bought once',color:col('--acc'),daily:subDays.map(d=>pDay.once[d]||0)},{label:'Monthly',color:col('--c4'),daily:subDays.map(d=>pDay.monthly[d]||0)}],{keepZero:false});
 const nOnce=paid.filter(a=>a.plan==='once').length,nMon=paid.filter(a=>a.plan==='monthly').length;
 $('subSub').textContent='paid only, gifts excluded: '+nOnce+' bought once (£11.99), '+nMon+' monthly (£1.99)';
 const acc=A.length,conv=totDl?100*acc/totDl:0;
 kp.push(['Accounts',acc,'<i>+'+accDaily.slice(-7).reduce((s,v)=>s+v,0)+' in 7 days</i>'],['Download → account',pct(conv),'all time'],
  ['Paid Premium',nOnce+nMon,nOnce+' once · '+nMon+' monthly'],['Est. revenue',GBP(nOnce*11.99+nMon*1.99),'gross, first payments']);
}
if(U){
 // ---- time per day: the growth of the all-users total between two daily snapshots
 const tDays=[],all=[],pd=[],gf=[],fr=[],tot=[],totP=[],totG=[],totF=[];
 for(let i=1;i<H.length;i++){const a=H[i-1],b=H[i];if(a.minutes==null||b.minutes==null)continue;const n=Math.max(1,Math.round((Date.parse(b.date)-Date.parse(a.date))/DAY));
  tDays.push(b.date);all.push(Math.max(0,b.minutes-a.minutes)/60/n);tot.push(b.minutes/60);
  const sp=(k)=>a[k]!=null&&b[k]!=null?Math.max(0,b[k]-a[k])/60/n:null;pd.push(sp('minPaid'));gf.push(sp('minGift'));fr.push(sp('minFree'));
  totP.push(b.minPaid!=null?b.minPaid/60:null);totG.push(b.minGift!=null?b.minGift/60:null);totF.push(b.minFree!=null?b.minFree/60:null)}
 if(tDays.length)dual('cUse',tDays,[{label:'All users',color:col('--acc'),daily:all,total:tot},{label:'Paid Premium',color:col('--c4'),daily:pd,total:totP},{label:'Launch gift',color:col('--c2'),daily:gf,total:totG},{label:'Free',color:col('--c3'),daily:fr,total:totF}],{fmt:hrs,prec:1});
 else $('cUse').closest('.chart').outerHTML='<p class=mut>Fills in after two daily snapshots.</p>';
 // ---- per plan
 const grp=['once','monthly','gift','free'].map(k=>{const g=U.filter(u=>u.plan===k),m=g.reduce((s,x)=>s+x.minutes,0),srt=g.map(x=>x.minutes).sort((p,q)=>p-q);
  return {k,n:g.length,m,avg:g.length?m/g.length:0,med:srt.length?srt[Math.floor(srt.length/2)]:0,ses:g.length?g.reduce((s,x)=>s+x.sessions,0)/g.length:0,tr:g.reduce((s,x)=>s+x.tracks,0),ex:g.reduce((s,x)=>s+x.exports,0),act:g.filter(x=>x.last&&Date.now()-Date.parse(x.last)<7*DAY).length}});
 $('planT').innerHTML='<tr><th>Plan</th><th class=r>Accounts</th><th class=r>Active (7 d)</th><th class=r>Total time</th><th class=r>Average per account</th><th class=r>Median</th><th class=r>Sessions / account</th><th class=r>Tracks</th><th class=r>Exports</th></tr>'+
  grp.map(g=>'<tr><td>'+plans[g.k]+'</td><td class=r>'+g.n+'</td><td class=r>'+g.act+'</td><td class=r>'+hm(g.m)+'</td><td class=r><b>'+hm(g.avg)+'</b></td><td class=r>'+hm(g.med)+'</td><td class=r>'+g.ses.toFixed(1)+'</td><td class=r>'+g.tr+'</td><td class=r>'+g.ex+'</td></tr>').join('');
 // ---- active accounts, tracks, exports from the snapshots
 const sd=H.map(s=>s.date);
 dual('cAct',sd,[{label:'Active accounts',color:col('--c3'),daily:H.map(s=>s.active??null)}],{single:true,keepZero:true});
 const dlt=(k)=>H.map((s,i)=>i&&s[k]!=null&&H[i-1][k]!=null?Math.max(0,s[k]-H[i-1][k]):null);
 dual('cTr',sd,[{label:'Tracks created',color:col('--c2'),daily:dlt('tracks'),total:H.map(s=>s.tracks??null)},{label:'Exports',color:col('--c4'),daily:dlt('exports'),total:H.map(s=>s.exports??null)}]);
 const tm=U.reduce((s,x)=>s+x.minutes,0),pay=grp.filter(g=>g.k==='once'||g.k==='monthly'),payN=pay.reduce((s,g)=>s+g.n,0),payM=pay.reduce((s,g)=>s+g.m,0),fre=grp.find(g=>g.k==='free');
 kp.push(['Active (7 d)',last.active??'-',''],['Time in app',hm(tm),U.length?'avg '+hm(tm/U.length)+' / account':''],['Avg time, paid',payN?hm(payM/payN):'-','free: '+hm(fre.avg)],
  ['Tracks',U.reduce((s,x)=>s+x.tracks,0),''],['Exports',U.reduce((s,x)=>s+x.exports,0),'']);
 const R=D.ratings;kp.push(['Rating',R.length?(R.reduce((s,x)=>s+x.stars,0)/R.length).toFixed(1)+' ★':'-',R.length+' ratings']);
 {const v={};U.forEach(u=>v[u.version]=(v[u.version]||0)+1);const ks=Object.keys(v).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  new Chart($('cVer'),{type:'doughnut',data:{labels:ks.map(k=>'v'+k+' ('+v[k]+')'),datasets:[{data:ks.map(k=>v[k]),backgroundColor:[col('--acc'),col('--c2'),col('--c3'),col('--c4'),'#ff8fa3','#9aa0ad','#f2d16b','#4fd1c5'],borderColor:col('--card')}]},options:{plugins:{legend:{position:'right'}}}});}
 {const cnt=[5,4,3,2,1].map(k=>[k,R.filter(x=>x.stars===k).length]);$('ratingSub').textContent=R.length?'average '+(R.reduce((s,x)=>s+x.stars,0)/R.length).toFixed(2)+' from '+R.length+' ratings':'no ratings yet';
  $('rateT').innerHTML=cnt.map(([k,n])=>'<tr><td class=st>'+'★'.repeat(k)+'<span class=off>'+'★'.repeat(5-k)+'</span></td><td class=r>'+n+'</td><td class=r mut>'+(R.length?Math.round(100*n/R.length)+'%':'')+'</td></tr>').join('');}
 const rows=[...U].sort((a,b)=>b.minutes-a.minutes);$('usageSub').textContent=U.length+' accounts with usage, most active first';
 $('usageT').innerHTML='<tr><th>Account</th><th>Plan</th><th class=r>Time</th><th class=r>Sessions</th><th class=r>Tracks</th><th class=r>Exports</th><th>Version</th><th class=r>Last used</th></tr>'+rows.map(u=>'<tr><td>'+e(u.who)+'</td><td>'+(plans[u.plan]||'-')+'</td><td class=r>'+hm(u.minutes)+'</td><td class=r>'+u.sessions+'</td><td class=r>'+u.tracks+'</td><td class=r>'+u.exports+'</td><td>v'+e(u.version)+'</td><td class=r>'+(u.last?new Date(u.last).toLocaleDateString('en-GB'):'-')+'</td></tr>').join('');
 $('fbList').innerHTML=D.ratings.map(x=>'<div class=fb><span class=st>'+'★'.repeat(x.stars)+'<span class=off>'+'★'.repeat(5-x.stars)+'</span></span> <span class=mut>'+e(x.who)+' · v'+e(x.version)+' · '+(x.at?new Date(x.at).toLocaleDateString('en-GB'):'')+'</span>'+(x.text?'<div>'+e(x.text)+'</div>':'')+'</div>').join('')||'<span class=mut>None yet</span>';
}else{['cAcc','cConv','cSub','cUse','cAct','cTr','cVer'].forEach(i=>$(i).closest('.card').remove());['planT','usageT','rateT'].forEach(i=>$(i).closest('.card').remove());$('fbList').closest('.card').remove();}
$('kpis').innerHTML=kp.map(k=>'<div class=kpi><span>'+k[0]+'</span><b>'+k[1]+'</b><i>'+(k[2]||'')+'</i></div>').join('');
$('relT').innerHTML='<tr><th>Release</th><th>Date</th><th class=r>Downloads</th></tr>'+[...D.dl].reverse().map(x=>'<tr><td>'+e(x.tag)+'</td><td>'+x.date+'</td><td class=r>'+x.n+'</td></tr>').join('');
if(D.tr){const T=D.tr,td=T.views.map(x=>x[0]);dual('cTraf',td,[{label:'Views',color:col('--acc'),daily:T.views.map(x=>x[1])},{label:'Unique visitors',color:col('--c3'),daily:T.views.map(x=>x[2])}],{single:true,keepZero:true});}
else $('trafficCard').remove();
}
async function open(pw){const b=(s)=>Uint8Array.from(atob(s),(c)=>c.charCodeAt(0));
 const k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:b(S.salt),iterations:S.iter,hash:'SHA-256'},await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']),{name:'AES-GCM',length:256},false,['decrypt']);
 return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b(S.iv)},k,b(S.ct))));}
if(P)main(P);else{$('lock').hidden=false;$('lock').addEventListener('submit',async(ev)=>{ev.preventDefault();$('lockErr').textContent='';let d;
 try{d=await open($('pw').value)}catch{$('lockErr').textContent='Wrong password';return}
 $('lock').hidden=true;main(d);});}
</script></html>`;
}

// ---------- main ----------
async function collect() {
  const errors = [];
  if (DEMO) { const d = demo(); return { ...d, errors }; }
  const pw = password(), h = readHistory(pw), before = JSON.stringify(h);
  const [dl, fb, tr] = await Promise.all([downloads(), firebase().catch((e) => { errors.push('Database: ' + e.message); return null; }), traffic().catch((e) => { errors.push('Traffic: ' + e.message); return null; })]);
  updateHistory(h, dl, fb);
  if (fb && !SERVE) {
    const recent = Date.now() - 15 * 60e3;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'public.json'), JSON.stringify({ tracks: fb.usage.reduce((s, x) => s + x.tracks, 0), live: fb.usage.filter((x) => x.last && new Date(x.last) > recent).length, updated: new Date().toISOString() }));
  }
  // only when something changed: sealing is random, so it would otherwise commit every hour
  if (!SERVE && JSON.stringify(h) !== before) { fs.mkdirSync(path.dirname(HISTORY), { recursive: true }); fs.writeFileSync(HISTORY, JSON.stringify(seal(JSON.stringify(h), pw))); }
  return { dl, fb, tr, history: h.snapshots, events: h.events, errors };
}
// demo returns history as a plain array, real returns snapshots; render() handles both
async function build() {
  const d = await collect();
  return render(d);
}
const LOCKED = `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content="noindex"><title>SectorOne stats</title><body style="background:#0b0c10;color:#8a8f9c;font:15px system-ui;text-align:center;padding-top:20vh">Not available.</body></html>`;
if (require.main === module) (async () => {
  if (!SERVE && !password()) {
    // Fail closed: no password means no data is collected or published.
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'index.html'), LOCKED);
    console.log('no STATS_PASSWORD: published the empty page');
    return;
  }
  if (SERVE) {
    http.createServer(async (_, res) => { try { const h = await build(); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); } catch (e) { res.writeHead(500); res.end(String(e)); } })
      .listen(Number(process.env.STATS_PORT) || 5199, '127.0.0.1', () => console.log('http://localhost:' + (process.env.STATS_PORT || 5199)));
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'index.html'), await build());
    console.log('wrote site/index.html');
  }
})().catch((e) => { console.error(e); process.exit(1); });
module.exports = { seal, unseal, HISTORY, PW_FILE };
