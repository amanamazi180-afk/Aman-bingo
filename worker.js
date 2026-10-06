// Aman Bingo server — Cloudflare Worker + D1 database.
// Money is stored in cents (birr x 100). Variables to set in Cloudflare:
//   BOT_TOKEN, ADMIN_TG_ID, SMS_SECRET, TG_SECRET, ADMIN_KEY (secrets) · GAME_URL, ALLOW_ORIGIN, STAKE (plain variables)
const LOBBY_MS = 40000, CALL_MS = 4000, REST_MS = 8000, CUT = 0.8, MAXC = 2, TOTAL = 400, MIN_DEP = 30, MIN_WD = 50;
const C = x => Math.round(Number(x) * 100), B = c => c / 100;
const welcomeC = env => C(env.WELCOME_BONUS ?? 10); // one-time gift when a player registers
const bonusC = env => C(env.DAILY_BONUS ?? 0), // daily bonus is off unless DAILY_BONUS is set
   bonusPeriod = now => Math.floor((now - 5 * 36e5) / 864e5); // new period starts 08:00 Ethiopia time (05:00 UTC)
const refreshBonusStmt = (env, id, now) => env.DB.prepare('UPDATE users SET bonus_c=?1,bonus_period=?2 WHERE id=?3 AND (bonus_period<?2 OR (?1=0 AND bonus_c<>0))').bind(bonusC(env), bonusPeriod(now), id); // resets to the daily amount (0 = off), never added on top
const refreshBonus = (env, id, now) => refreshBonusStmt(env, id, now).run();
const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

/* ---------- pure game logic (same card generator as the app) ---------- */
export function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
export function numberOrder(seed) { const r = mulberry(seed), a = Array.from({ length: 75 }, (_, i) => i + 1); for (let i = 74; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }
export function makeCard(no) {
  let s = no * 7919 + 13; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }, cols = [];
  for (let c = 0; c < 5; c++) { const pool = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1), out = []; for (let i = 0; i < 5; i++) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]); cols.push(out) }
  cols[2][2] = 0; return cols;
}
export function hasBingo(card, marked) {
  const m = (c, r) => { const v = card[c][r]; return v === 0 || marked.has(v) }, n = [0, 1, 2, 3, 4];
  for (let i = 0; i < 5; i++) if (n.every(j => m(j, i)) || n.every(j => m(i, j))) return true;
  return n.every(i => m(i, i)) || n.every(i => m(i, 4 - i));
}
// earliest call number at which any picked cartela completes; every cartela completing on that call wins (ties split)
export function findWinners(order, picks, k) {
  const cards = picks.map(p => makeCard(p.cartela)), marked = new Set();
  for (let kk = 1; kk <= k; kk++) { marked.add(order[kk - 1]); const w = picks.filter((_, i) => hasBingo(cards[i], marked)); if (w.length) return { k: kk, picks: w } }
  return null;
}
export function parseSms(t) { // Telebirr "received" message
  t = String(t || '');
  const amt = t.match(/([\d,]+(?:\.\d+)?)\s*ብር\s*በ\s*\d{2}\/\d{2}\/\d{4}/), id = t.match(/ቁጥርዎ\s+([A-Z0-9]{8,14})/i);
  if (!amt || !id || !/ተቀብለዋል/.test(t)) return null;
  return { amount_c: C(amt[1].replace(/,/g, '')), txid: id[1].toUpperCase() };
}
export function normPhone(p) { p = String(p || '').replace(/[\s-]/g, ''); if (/^\+?251[79]\d{8}$/.test(p)) p = '0' + p.replace(/^\+?251/, ''); return /^0[79]\d{8}$/.test(p) ? p : null }

/* ---------- Telegram helpers ---------- */
async function hmac(key, msg) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg)) }
export async function verifyInit(initData, token, maxAge = 86400) {
  const p = new URLSearchParams(initData || ''), hash = p.get('hash'); if (!hash) return null; p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n'), enc = new TextEncoder();
  const sig = await hmac(await hmac(enc.encode('WebAppData'), enc.encode(token)), enc.encode(str));
  if ([...sig].map(b => b.toString(16).padStart(2, '0')).join('') !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > maxAge) return null;
  try { return JSON.parse(p.get('user')) } catch (e) { return null }
}
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => { });
// Owners come from the ADMIN_TG_ID secret (can hold several ids: 111,222). Extra admins live in the database and are managed with /addadmin /removeadmin /admins.
const owners = env => String(env.ADMIN_TG_ID || '').split(',').map(s => s.trim()).filter(Boolean);
let adminsReady = false;
const dbAdmins = async env => { try { if (!adminsReady) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,added_ts INTEGER)').run(); adminsReady = true } return (await env.DB.prepare('SELECT id FROM admins').all()).results.map(r => String(r.id)) } catch (e) { return [] } };
const admins = async env => [...new Set([...owners(env), ...await dbAdmins(env)])];
const isOwner = (env, id) => owners(env).includes(String(id));
const isAdmin = async (env, id) => isOwner(env, id) || (await dbAdmins(env)).includes(String(id));
const adminUrl = env => env.ADMIN_URL || 'https://amanamazi180-afk.github.io/Aman-bingo/admin.html';
const say = async (env, chat, text, kb) => { // the Admin button is added only for an admin's own chat
  if (kb && kb[0] && kb[0][0] && kb[0][0].web_app && await isAdmin(env, chat)) kb = [...kb, [{ text: 'Admin 🛠', web_app: { url: adminUrl(env) } }]];
  return tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: kb ? { inline_keyboard: kb } : undefined });
};
const playKb = env => [[{ text: '🎮 ተጫወት', web_app: { url: env.GAME_URL } }]];

/* ---------- bot menu (bottom keyboard) and Amharic texts ---------- */
const SUPPORT = '@Amanbing2';
const BTN = { play: '🎮 ጨዋታ ተጫወት', dep: '💰 ገንዘብ አስገባ', bal: '💳 ቀሪ ሂሳብ', sup: '🆘 እርዳታ' };
const sendTo = (env, chat, text, markup) => tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: markup });
const SHARE_KB = { keyboard: [[{ text: '📱 ስልክ ቁጥሬን አጋራ', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const mainKbFor = async (env, id) => { // the 4 bottom buttons (admins also get an Admin button)
  const rows = [[{ text: BTN.play, web_app: { url: env.GAME_URL } }], [{ text: BTN.dep }, { text: BTN.bal }], [{ text: BTN.sup }]];
  if (await isAdmin(env, id)) rows.push([{ text: 'Admin 🛠', web_app: { url: adminUrl(env) } }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
};
const askContact = (env, uid) => sendTo(env, uid, '👋 እንኳን ወደ አማን ቢንጎ በደህና መጡ!\n\nለመመዝገብ ከታች ያለውን «📱 ስልክ ቁጥሬን አጋራ» ቁልፍ ይጫኑ።' + (welcomeC(env) > 0 ? `\n🎁 ሲመዘገቡ ${B(welcomeC(env))} ብር ስጦታ ያገኛሉ!` : ''), SHARE_KB);
const depositInfo = `💰 ገንዘብ ለማስገባት (ቢያንስ ${MIN_DEP} ብር)፦\n\n📱 Telebirr: 0958828304 (AMANUEL)\n🏦 BOA: 266199511 (AMANUEL YISMAH)\n🏦 Dashen: 5901914597011 (AMANUEL YISMAH)\n\nገንዘቡን ከላኩ በኋላ ጨዋታውን ከፍተው «ዋሌት» ውስጥ «Deposit» ን ተጭነው የግብይት ቁጥር (Transaction ID) ያስገቡ።`;
async function onContact(env, m) { // the player shared their phone number: register and give the welcome bonus
  const db = env.DB, uid = m.from.id, c = m.contact, now = Date.now();
  if (c.user_id && Number(c.user_id) !== Number(uid)) return sendTo(env, uid, '⚠️ እባክዎ የራስዎን ስልክ ቁጥር ብቻ ያጋሩ።', SHARE_KB);
  const ph = normPhone(c.phone_number);
  if (!ph) return sendTo(env, uid, '⚠️ ይህ ስልክ ቁጥር ትክክል አይደለም። የኢትዮጵያ ቁጥር (09… ወይም 07…) ያስፈልጋል።', SHARE_KB);
  const nm = String(c.first_name || m.from.first_name || 'player').trim().slice(0, 30) || 'player';
  await db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(uid, nm, now).run();
  const u = await db.prepare('SELECT phone FROM users WHERE id=?').bind(uid).first();
  if (u && u.phone) return sendTo(env, uid, '✅ አስቀድመው ተመዝግበዋል። ለመጫወት «' + BTN.play + '» ይጫኑ።', await mainKbFor(env, uid));
  let ok = false;
  try { ok = (await db.prepare("UPDATE users SET name=?1,phone=?2,balance=balance+?3 WHERE id=?4 AND (phone IS NULL OR phone='')").bind(nm, ph, welcomeC(env), uid).run()).meta.changes > 0 }
  catch (e) { return sendTo(env, uid, `⚠️ ይህ ስልክ ቁጥር በሌላ አካውንት ተመዝግቧል። ለእርዳታ ${SUPPORT} ያነጋግሩ።`, SHARE_KB) }
  if (!ok) return sendTo(env, uid, '✅ አስቀድመው ተመዝግበዋል።', await mainKbFor(env, uid));
  return sendTo(env, uid, '🎉 እንኳን ደስ አለዎት! በተሳካ ሁኔታ ተመዝግበዋል።' + (welcomeC(env) > 0 ? `\n🎁 ${B(welcomeC(env))} ብር የእንኳን ደህና መጡ ስጦታ ወደ ዋሌትዎ ተጨምሯል።` : '') + '\n\nለመጫወት «' + BTN.play + '» ይጫኑ።', await mainKbFor(env, uid));
}

/* ---------- money operations (each is one atomic batch) ---------- */
async function tryMatch(env, txid) { // credit a pending deposit when a matching unclaimed SMS exists
  const db = env.DB;
  const r = await db.batch([
    db.prepare("UPDATE users SET balance=balance+(SELECT d.amount_c FROM deposits d WHERE d.txid=?1) WHERE id=(SELECT d.user_id FROM deposits d JOIN sms_log s ON s.txid=d.txid WHERE d.txid=?1 AND d.status='pending' AND s.claimed=0 AND s.amount_c=d.amount_c)").bind(txid),
    db.prepare("UPDATE deposits SET status='approved',note='auto' WHERE txid=?1 AND status='pending' AND EXISTS(SELECT 1 FROM sms_log s WHERE s.txid=?1 AND s.claimed=0 AND s.amount_c=deposits.amount_c)").bind(txid),
    db.prepare("UPDATE sms_log SET claimed=1 WHERE txid=?1 AND claimed=0 AND EXISTS(SELECT 1 FROM deposits d WHERE d.txid=?1 AND d.status='approved')").bind(txid)]);
  if (r[1].meta.changes > 0) { const d = await db.prepare('SELECT user_id,amount_c FROM deposits WHERE txid=?').bind(txid).first(); say(env, d.user_id, `✅ የ${B(d.amount_c)} ብር ገቢዎ ተቀብለናል።`, playKb(env)); return true }
  return false;
}
async function decideDeposit(env, id, ok) {
  const db = env.DB;
  const r = await db.batch(ok ? [
    db.prepare("UPDATE users SET balance=balance+(SELECT amount_c FROM deposits WHERE id=?1 AND status='pending') WHERE id=(SELECT user_id FROM deposits WHERE id=?1 AND status='pending')").bind(id),
    db.prepare("UPDATE deposits SET status='approved',note='admin' WHERE id=?1 AND status='pending'").bind(id)
  ] : [db.prepare("UPDATE deposits SET status='rejected',note='admin' WHERE id=?1 AND status='pending'").bind(id)]);
  const done = r[r.length - 1].meta.changes > 0;
  if (done) { const d = await db.prepare('SELECT user_id,amount_c FROM deposits WHERE id=?').bind(id).first(); say(env, d.user_id, ok ? `✅ የ${B(d.amount_c)} ብር ገቢዎ ጸድቋል።` : `❌ ገቢዎ ውድቅ ተደርጓል። ለእርዳታ ${SUPPORT} ያነጋግሩ።`, ok ? playKb(env) : undefined) }
  return done;
}
async function decideWithdraw(env, id, paid) {
  const db = env.DB;
  const r = await db.batch(paid ? [db.prepare("UPDATE withdrawals SET status='paid' WHERE id=?1 AND status='pending'").bind(id)] : [
    db.prepare("UPDATE users SET balance=balance+(SELECT amount_c FROM withdrawals WHERE id=?1 AND status='pending') WHERE id=(SELECT user_id FROM withdrawals WHERE id=?1 AND status='pending')").bind(id),
    db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?1 AND status='pending'").bind(id)]);
  const done = r[r.length - 1].meta.changes > 0;
  if (done) { const w = await db.prepare('SELECT user_id,amount_c FROM withdrawals WHERE id=?').bind(id).first(); say(env, w.user_id, paid ? `✅ ${B(w.amount_c)} ብር ተልኮልዎታል።` : `↩️ የማውጣት ጥያቄዎ ውድቅ ተደርጓል — ${B(w.amount_c)} ብር ወደ ቀሪ ሂሳብዎ ተመልሷል።`) }
  return done;
}

/* ---------- settings, bans and admin log (tables are created automatically) ---------- */
let tablesReady = false;
const ensureTables = async env => { if (tablesReady) return; await env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS bans(id INTEGER PRIMARY KEY)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,actor TEXT,action TEXT,detail TEXT)')]); tablesReady = true };
const cfg = { t: 0, set: {}, bans: new Set() }; // settings and bans are cached for 5 seconds to keep requests fast
const loadCfg = async env => { if (Date.now() - cfg.t < 5000) return cfg; await ensureTables(env); const [a, b] = await env.DB.batch([env.DB.prepare('SELECT k,v FROM settings'), env.DB.prepare('SELECT id FROM bans')]); cfg.set = Object.fromEntries(a.results.map(r => [r.k, r.v])); cfg.bans = new Set(b.results.map(r => String(r.id))); cfg.t = Date.now(); return cfg };
const getSet = async (env, k) => (await loadCfg(env)).set[k] ?? null;
const setSet = async (env, k, v) => { await ensureTables(env); await env.DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run(); cfg.t = 0 };
const isBanned = async (env, id) => (await loadCfg(env)).bans.has(String(id));

/* ---------- shared game rounds (advanced lazily on every request) ---------- */
const latest = db => db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').first();
const callsAt = (r, now) => Math.min(75, Math.max(0, Math.floor((now - r.start_ts - LOBBY_MS) / CALL_MS) + 1));
function refundAndClose(env, r, from, now) {
  const db = env.DB;
  return db.batch([
    db.prepare("UPDATE users SET bonus_c=MIN(?5,bonus_c+(SELECT COALESCE(SUM(p.bonus_c),0) FROM picks p WHERE p.round_id=?1 AND p.user_id=users.id)),balance=balance+(SELECT COUNT(*)*?2-COALESCE(SUM(p.bonus_c),0) FROM picks p WHERE p.round_id=?1 AND p.user_id=users.id) WHERE id IN(SELECT user_id FROM picks WHERE round_id=?1) AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status=?4)").bind(r.id, r.stake_c, now, from, bonusC(env)),
    db.prepare("UPDATE rounds SET status='cancelled',ended_ts=?3 WHERE id=?1 AND status=?2").bind(r.id, from, now)]);
}
async function advance(env) {
  const db = env.DB, now = Date.now(); let r = await latest(db);
  if (!r || (r.status !== 'lobby' && r.status !== 'running' && now - r.ended_ts >= REST_MS)) {
    if (!r || (await getSet(env, 'paused')) !== '1') { // admin can pause new rounds
      await db.prepare("INSERT INTO rounds(start_ts,seed,status,stake_c) SELECT ?1,?2,'lobby',?3 WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE status IN('lobby','running'))").bind(now, rnd32(), C((await getSet(env, 'stake')) || env.STAKE || 10)).run();
      r = await latest(db);
    }
  }
  if (r.status === 'lobby' && now - r.start_ts >= LOBBY_MS) {
    const n = (await db.prepare('SELECT COUNT(DISTINCT user_id) n FROM picks WHERE round_id=?').bind(r.id).first()).n;
    if (n < 2) await refundAndClose(env, r, 'lobby', now); // a game needs at least 2 players
    else await db.prepare("UPDATE rounds SET status='running' WHERE id=?1 AND status='lobby'").bind(r.id).run();
    r = await db.prepare('SELECT * FROM rounds WHERE id=?').bind(r.id).first();
  }
  if (r.status === 'running') {
    const k = callsAt(r, now), picks = (await db.prepare('SELECT cartela,user_id FROM picks WHERE round_id=?').bind(r.id).all()).results;
    const w = findWinners(numberOrder(r.seed), picks, k);
    if (w) {
      const prize = Math.floor(picks.length * r.stake_c * CUT), share = Math.floor(prize / w.picks.length);
      await db.batch([...w.picks.map(p => db.prepare("UPDATE users SET balance=balance+?3 WHERE id=?2 AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status='running')").bind(r.id, p.user_id, share)),
        db.prepare("UPDATE rounds SET status='ended',ended_ts=?2,called_n=?3,winners=?4 WHERE id=?1 AND status='running'").bind(r.id, now, w.k, JSON.stringify(w.picks.map(p => p.cartela)))]);
    } else if (k >= 75) await refundAndClose(env, r, 'running', now);
    r = await db.prepare('SELECT * FROM rounds WHERE id=?').bind(r.id).first();
  }
  return r;
}
async function stateFor(env, u, round) {
  const db = env.DB, r = round || await advance(env), now = Date.now();
  const [pr, mr] = await db.batch([db.prepare('SELECT p.cartela,p.user_id,u.name FROM picks p JOIN users u ON u.id=p.user_id WHERE p.round_id=?').bind(r.id), db.prepare('SELECT balance,bonus_c FROM users WHERE id=?').bind(u.id)]);
  const picks = pr.results, me = mr.results[0];
  const n = r.status === 'running' ? callsAt(r, now) : r.status === 'ended' ? r.called_n : 0;
  const win = r.status === 'ended' ? JSON.parse(r.winners || '[]') : [];
  return { now, round: { id: r.id, status: r.status, start_ts: r.start_ts, lobby_ms: LOBBY_MS, call_ms: CALL_MS, stake: B(r.stake_c), rest_ms: REST_MS, ended_ts: r.ended_ts },
    taken: picks.map(p => p.cartela), mine: picks.filter(p => p.user_id === u.id).map(p => p.cartela),
    called: numberOrder(r.seed).slice(0, n), players: new Set(picks.map(p => p.user_id)).size, cards: picks.length,
    derash: B(Math.floor(picks.length * r.stake_c * CUT)), winners: picks.filter(p => win.includes(p.cartela)).map(p => ({ cartela: p.cartela, name: p.name })), balance: B(me.balance), bonus: B(me.bonus_c) };
}
const startOfDay = () => Math.floor((Date.now() + 3 * 36e5) / 864e5) * 864e5 - 3 * 36e5; // Ethiopia time (UTC+3)
async function leaderboard(env, u, period) {
  const db = env.DB, since = period === 'weekly' ? Date.now() - 7 * 864e5 : startOfDay();
  const base = "FROM picks p JOIN rounds r ON r.id=p.round_id WHERE r.status='ended' AND r.ended_ts>=?1";
  const top = (await db.prepare(`SELECT u.name n,COUNT(DISTINCT p.round_id) g ${base.replace('WHERE', 'JOIN users u ON u.id=p.user_id WHERE')} GROUP BY u.id ORDER BY g DESC LIMIT 10`).bind(since).all()).results;
  const mine = (await db.prepare(`SELECT COUNT(DISTINCT p.round_id) g ${base} AND p.user_id=?2`).bind(since, u.id).first()).g || 0;
  const higher = (await db.prepare(`SELECT COUNT(*) c FROM(SELECT p.user_id,COUNT(DISTINCT p.round_id) g ${base} GROUP BY p.user_id HAVING g>?2)`).bind(since, mine).first()).c;
  return { top: top.map(t => [t.n, t.g]), me: { rank: mine ? higher + 1 : null, played: mine } };
}

/* ---------- Telegram bot (commands + admin buttons) ---------- */
async function onTelegram(env, up) {
  const db = env.DB;
  if (up.callback_query) {
    const q = up.callback_query, [a, id] = String(q.data).split(':');
    if (!(await isAdmin(env, q.from.id))) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Admin only' });
    const ok = a === 'da' ? await decideDeposit(env, +id, true) : a === 'dr' ? await decideDeposit(env, +id, false) : a === 'wp' ? await decideWithdraw(env, +id, true) : a === 'wr' ? await decideWithdraw(env, +id, false) : false;
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: ok ? 'Done' : 'Already processed' });
    return tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: q.message.text + (ok ? '\n\n✔ Done' : '\n\n(already processed)') });
  }
  const m = up.message; if (!m) return;
  if (m.contact) return onContact(env, m); // player shared their phone number
  if (!m.text) return;
  const text = m.text.trim(), cmd = text.split(/[\s@]/)[0].toLowerCase(), uid = m.from.id; await refreshBonus(env, uid, Date.now()); const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
  if (cmd === '/balance' || text === BTN.bal) {
    if (!u || !u.phone) return askContact(env, uid);
    return sendTo(env, uid, `💳 ቀሪ ሂሳብዎ: ${B(u.balance)} ብር` + (u.bonus_c > 0 ? `\n🎁 ቦነስ: ${B(u.bonus_c)} ብር` : ''), await mainKbFor(env, uid));
  }
  if (isOwner(env, uid) && (cmd === '/addadmin' || cmd === '/removeadmin' || cmd === '/admins')) {
    const list = await admins(env), id = (m.text.split(/\s+/)[1] || '').replace(/\D/g, '');
    if (cmd === '/admins') return say(env, uid, 'Admins:\n' + list.join('\n'));
    if (!id) return say(env, uid, 'Send it like this: ' + cmd + ' 123456789');
    if (cmd === '/addadmin') { await db.prepare('INSERT OR IGNORE INTO admins(id,added_ts) VALUES(?,?)').bind(Number(id), Date.now()).run(); await say(env, id, 'You are now an admin. Send /admin to open the dashboard.'); return say(env, uid, '✅ Added admin ' + id) }
    if (isOwner(env, id)) return say(env, uid, 'Owners can only be changed in Cloudflare.');
    await db.prepare('DELETE FROM admins WHERE id=?').bind(Number(id)).run(); return say(env, uid, '✅ Removed admin ' + id);
  }
  if (cmd === '/pending' && await isAdmin(env, uid)) {
    const d = (await db.prepare("SELECT d.*,u.name,u.phone FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.status='pending'").all()).results, w = (await db.prepare("SELECT w.*,u.name,u.phone FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending'").all()).results;
    if (!d.length && !w.length) return say(env, uid, 'Nothing pending ✅');
    for (const x of d) await say(env, uid, depositText(x), [[{ text: '✅ Approve', callback_data: 'da:' + x.id }, { text: '❌ Reject', callback_data: 'dr:' + x.id }]]);
    for (const x of w) await say(env, uid, withdrawText(x), [[{ text: '💸 Mark paid', callback_data: 'wp:' + x.id }, { text: '↩️ Reject', callback_data: 'wr:' + x.id }]]);
    return;
  }
  if (cmd === '/admin' && await isAdmin(env, uid)) return tg(env, 'sendMessage', { chat_id: uid, text: 'Admin dashboard', reply_markup: { inline_keyboard: [[{ text: 'Open admin 🛠', web_app: { url: adminUrl(env) } }]] } });
  if (!u || !u.phone) return askContact(env, uid); // new player: must share the phone number first
  const kb = await mainKbFor(env, uid);
  if (text === BTN.dep || cmd === '/deposit') return sendTo(env, uid, depositInfo, kb);
  if (text === BTN.sup || cmd === '/support') return sendTo(env, uid, `🆘 ለእርዳታ ያነጋግሩን: ${SUPPORT}`, kb);
  if (cmd === '/withdraw') return sendTo(env, uid, '💸 ገንዘብ ለማውጣት ጨዋታውን ከፍተው «ዋሌት» ውስጥ «Withdraw» ን ይጫኑ።', kb);
  return sendTo(env, uid, '🎮 እንኳን ደህና መጡ! ለመጫወት «' + BTN.play + '» ይጫኑ።', kb);
}
const depositText = x => `💰 Deposit #${x.id}\n${x.name} · ${x.phone}\nAmount: ${B(x.amount_c)} birr via ${x.method}\nTransaction: ${x.txid}\nNo matching SMS yet — approve only if the money arrived.`;
const notifyAdmins = async (env, text, kb) => Promise.all((await admins(env)).map(a => say(env, a, text, kb)));
const withdrawText = x => `💸 Withdrawal #${x.id}\n${x.name} · ${x.phone}\nAmount: ${B(x.amount_c)} birr\nSend to: ${x.method} ${x.account}`;

/* ---------- admin dashboard routes (password = ADMIN_KEY secret, or a Telegram admin account) ---------- */
async function adminRoute(req, env, url) {
  const key = req.headers.get('x-admin-key');
  let actor = null;
  if (env.ADMIN_KEY && key === env.ADMIN_KEY) actor = 'password';
  else { const tu = await verifyInit(req.headers.get('x-init-data'), env.BOT_TOKEN); if (tu && await isAdmin(env, tu.id)) actor = String(tu.id); }
  if (!actor) return J({ error: 'forbidden' }, 403);
  await ensureTables(env);
  const db = env.DB, name = url.pathname.replace('/api/admin/', '');
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const n = async sql => (await db.prepare(sql).first()).v || 0;
  const log = (action, detail) => db.prepare('INSERT INTO admin_log(ts,actor,action,detail) VALUES(?,?,?,?)').bind(Date.now(), actor, action, String(detail || '')).run();

  if (name === 'overview') {
    return J({
      players: await n('SELECT COUNT(*) v FROM users'),
      deposits: B(await n("SELECT SUM(amount_c) v FROM deposits WHERE status='approved'")),
      withdrawals: B(await n("SELECT SUM(amount_c) v FROM withdrawals WHERE status='paid'")),
      pending: (await n("SELECT COUNT(*) v FROM deposits WHERE status='pending'")) + (await n("SELECT COUNT(*) v FROM withdrawals WHERE status='pending'")),
      rounds: await n("SELECT COUNT(*) v FROM rounds WHERE status='ended'"),
      held: B(await n('SELECT SUM(balance) v FROM users'))
    });
  }
  if (name === 'pending') {
    const d = (await db.prepare("SELECT d.id,d.amount_c,d.method,d.txid,u.name,u.phone FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.status='pending' ORDER BY d.id").all()).results;
    const w = (await db.prepare("SELECT w.id,w.amount_c,w.method,w.account,u.name,u.phone FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.id").all()).results;
    return J({ items: [
      ...d.map(x => ({ type: 'deposit', id: x.id, amount: B(x.amount_c), name: x.name, phone: x.phone, detail: x.method + ' · tx ' + x.txid })),
      ...w.map(x => ({ type: 'withdraw', id: x.id, amount: B(x.amount_c), name: x.name, phone: x.phone, detail: 'send to ' + x.method + ' ' + x.account }))
    ] });
  }
  if (name === 'approve' || name === 'reject') {
    const id = Math.floor(Number(b.id)); if (!(id > 0)) return J({ error: 'bad_input' }, 400);
    const ok = name === 'approve'; let done;
    if (b.type === 'deposit') done = await decideDeposit(env, id, ok);
    else if (b.type === 'withdraw') done = await decideWithdraw(env, id, ok); // approve = mark paid, reject = refund balance
    else return J({ error: 'bad_input' }, 400);
    if (done) await log(name, b.type + ' #' + id);
    return J({ ok: done });
  }
  if (name === 'players') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 40), like = '%' + q + '%';
    const sql = 'SELECT u.id,u.name,u.phone,u.balance,(SELECT 1 FROM bans WHERE id=u.id) banned FROM users u' + (q ? ' WHERE u.name LIKE ?1 OR u.phone LIKE ?1 OR CAST(u.id AS TEXT) LIKE ?1' : '') + ' ORDER BY u.created_ts DESC LIMIT 100';
    const r = (await (q ? db.prepare(sql).bind(like) : db.prepare(sql)).all()).results;
    return J({ items: r.map(x => ({ id: x.id, name: x.name, phone: x.phone || 'not registered', balance: B(x.balance), banned: !!x.banned })) });
  }
  if (name === 'adjust') { // add (+) or remove (-) birr on a player's balance
    const id = Math.floor(Number(b.id)), amt = Number(b.amount);
    if (!(id > 0) || !isFinite(amt) || amt === 0 || Math.abs(amt) > 100000) return J({ error: 'bad_input' }, 400);
    try { const r = await db.prepare('UPDATE users SET balance=balance+?1 WHERE id=?2').bind(C(amt), id).run(); if (!r.meta.changes) return J({ error: 'no_player' }, 409) } catch (e) { return J({ error: 'insufficient_balance' }, 409) }
    await log(amt > 0 ? 'add balance' : 'remove balance', 'player ' + id + ' ' + amt + ' birr');
    say(env, id, amt > 0 ? `✅ ${amt} ብር ወደ ቀሪ ሂሳብዎ ተጨምሯል።` : `ℹ️ ${-amt} ብር ከቀሪ ሂሳብዎ በአስተዳዳሪ ተቀንሷል።`);
    return J({ ok: true, balance: B((await db.prepare('SELECT balance FROM users WHERE id=?').bind(id).first()).balance) });
  }
  if (name === 'ban' || name === 'unban') {
    const id = Math.floor(Number(b.id)); if (!(id > 0)) return J({ error: 'bad_input' }, 400);
    if (name === 'ban') await db.prepare('INSERT OR IGNORE INTO bans(id) VALUES(?)').bind(id).run(); else await db.prepare('DELETE FROM bans WHERE id=?').bind(id).run();
    cfg.t = 0;
    await log(name, 'player ' + id);
    return J({ ok: true });
  }
  if (name === 'rounds') {
    const r = (await db.prepare('SELECT r.id,r.status,r.stake_c,(SELECT COUNT(DISTINCT user_id) FROM picks WHERE round_id=r.id) players,(SELECT COUNT(*) FROM picks WHERE round_id=r.id) cards FROM rounds r ORDER BY r.id DESC LIMIT 30').all()).results;
    return J({ items: r.map(x => ({ id: x.id, status: x.status, players: x.players, pot: B(x.cards * x.stake_c) })) });
  }
  if (name === 'set-stake') {
    const st = Number(b.stake); if (!(st >= 1 && st <= 1000)) return J({ error: 'bad_input' }, 400);
    await setSet(env, 'stake', String(st)); await log('set stake', st + ' birr (from the next round)');
    return J({ ok: true, stake: st });
  }
  if (name === 'pause') {
    await setSet(env, 'paused', b.paused ? '1' : '0'); await log(b.paused ? 'pause game' : 'resume game', '');
    return J({ ok: true, paused: !!b.paused });
  }
  if (name === 'log') {
    const r = (await db.prepare('SELECT ts,actor,action,detail FROM admin_log ORDER BY id DESC LIMIT 30').all()).results;
    return J({ items: r });
  }
  if (name === 'game' || name === 'game-start' || name === 'game-stop') {
    let r = await advance(env);
    if (name === 'game-stop' && (r.status === 'lobby' || r.status === 'running')) {
      await refundAndClose(env, r, r.status, Date.now()); // cancels the round and returns every stake
      await log('cancel round', 'round ' + r.id); r = await advance(env);
    }
    const c = await db.prepare('SELECT COUNT(DISTINCT user_id) p,COUNT(*) c FROM picks WHERE round_id=?').bind(r.id).first();
    return J({ ok: true, status: r.status, round: r.id, stake: B(r.stake_c), next_stake: Number((await getSet(env, 'stake')) || env.STAKE || 10), paused: (await getSet(env, 'paused')) === '1', players: c.p, cards: c.c });
  }
  return J({ error: 'not_found' }, 404);
}

/* ---------- HTTP routes ---------- */
const errOf = e => /CHECK/.test(e.message) ? 'insufficient_balance' : /UNIQUE|PRIMARY/.test(e.message) ? 'taken' : 'server_error';
async function route(req, env, url) {
  const p = url.pathname, db = env.DB, now = Date.now();
  if (p === '/') return J({ ok: true });
  if (p === '/sms' && req.method === 'POST') { // phone forwards incoming Telebirr SMS here
    if (req.headers.get('x-secret') !== env.SMS_SECRET) return J({ error: 'forbidden' }, 403);
    const raw = await req.text(); let text = raw; try { const o = JSON.parse(raw); text = o.text || o.message || o.body || o.content || raw } catch (e) { }
    const s = parseSms(text); if (!s) return J({ ok: true, parsed: false });
    await db.prepare('INSERT OR IGNORE INTO sms_log(txid,amount_c,raw,ts) VALUES(?,?,?,?)').bind(s.txid, s.amount_c, String(text).slice(0, 500), now).run();
    await tryMatch(env, s.txid); return J({ ok: true, parsed: true });
  }
  if (p === '/tg/' + env.TG_SECRET && req.method === 'POST') { await onTelegram(env, await req.json()); return J({ ok: true }) }
  if (!p.startsWith('/api/')) return J({ error: 'not_found' }, 404);
  if (p.startsWith('/api/admin/')) return adminRoute(req, env, url);
  const tu = await verifyInit(req.headers.get('x-init-data'), env.BOT_TOKEN); if (!tu) return J({ error: 'unauthorized' }, 401);
  const rs = await db.batch([db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(tu.id, tu.first_name || 'player', now), refreshBonusStmt(env, tu.id, now), db.prepare('SELECT * FROM users WHERE id=?').bind(tu.id)]); // one round trip
  const u = rs[2].results[0], b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const need = () => u.phone ? null : J({ error: 'not_registered' }, 403);
  if (p !== '/api/me' && await isBanned(env, u.id)) return J({ error: 'banned' }, 403);
  if (p === '/api/me') { const dep = (await db.prepare('SELECT amount_c,status,ts FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results, wd = (await db.prepare('SELECT amount_c,status,ts FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results; return J({ id: u.id, name: u.name, phone: u.phone, registered: !!u.phone, balance: B(u.balance), bonus: B(u.bonus_c), deposits: dep.map(x => ({ ...x, amount: B(x.amount_c) })), withdrawals: wd.map(x => ({ ...x, amount: B(x.amount_c) })) }) }
  if (p === '/api/register') { if (u.phone) return J({ error: 'already_registered' }, 409); const ph = normPhone(b.phone), nm = String(b.name || '').trim().slice(0, 30); if (!ph || nm.length < 2) return J({ error: 'bad_input' }, 400);
    try { const rr = await db.prepare("UPDATE users SET name=?1,phone=?2,balance=balance+?3 WHERE id=?4 AND (phone IS NULL OR phone='')").bind(nm, ph, welcomeC(env), u.id).run(); if (!rr.meta.changes) return J({ error: 'already_registered' }, 409) } catch (e) { return J({ error: 'phone_used' }, 409) }
    if (welcomeC(env) > 0) await say(env, u.id, `🎉 እንኳን ደስ አለዎት! በተሳካ ሁኔታ ተመዝግበዋል። ${B(welcomeC(env))} ብር ወደ ዋሌትዎ ተጨምሯል።`, playKb(env));
    return J({ ok: true }) }
  if (p === '/api/state') return J(await stateFor(env, u));
  if (p === '/api/leaderboard') return J(await leaderboard(env, u, url.searchParams.get('period')));
  const bad = need(); if (bad) return bad;
  if (p === '/api/pick' || p === '/api/unpick') {
    const r = await advance(env), no = Math.floor(Number(b.cartela)); if (!(no >= 1 && no <= TOTAL)) return J({ error: 'bad_input' }, 400);
    if (r.status !== 'lobby' || now - r.start_ts >= LOBBY_MS) return J({ error: 'round_closed' }, 409);
    if (p === '/api/pick' && (await getSet(env, 'paused')) === '1') return J({ error: 'paused' }, 409);
    try {
      if (p === '/api/pick') {
        const res = await db.batch([
          db.prepare("INSERT INTO picks(round_id,cartela,user_id,bonus_c) SELECT ?1,?2,?3,MIN(?5,(SELECT bonus_c FROM users WHERE id=?3)) WHERE (SELECT COUNT(*) FROM picks WHERE round_id=?1 AND user_id=?3)<?4 AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status='lobby')").bind(r.id, no, u.id, MAXC, r.stake_c),
          db.prepare("UPDATE users SET bonus_c=bonus_c-(SELECT bonus_c FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3),balance=balance-(?4-(SELECT bonus_c FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3)) WHERE id=?3 AND EXISTS(SELECT 1 FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3)").bind(r.id, no, u.id, r.stake_c)]);
        if (res[0].meta.changes === 0) return J({ error: 'max_cards', max: MAXC }, 409);
      } else await db.batch([
        db.prepare("UPDATE users SET bonus_c=MIN(?5,bonus_c+(SELECT bonus_c FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3)),balance=balance+(?4-(SELECT bonus_c FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3)) WHERE id=?3 AND EXISTS(SELECT 1 FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3) AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status='lobby')").bind(r.id, no, u.id, r.stake_c, bonusC(env)),
        db.prepare("DELETE FROM picks WHERE round_id=?1 AND cartela=?2 AND user_id=?3 AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status='lobby')").bind(r.id, no, u.id)]);
    } catch (e) { return J({ error: errOf(e) }, 409) }
    return J(await stateFor(env, u, r));
  }
  if (p === '/api/deposit') {
    const amt = Number(b.amount), txid = String(b.txid || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), method = b.method === 'boa' ? 'boa' : 'telebirr';
    if (!(amt >= MIN_DEP) || txid.length < 8 || txid.length > 14) return J({ error: 'bad_input', min: MIN_DEP }, 400);
    let id; try { id = (await db.prepare('INSERT INTO deposits(user_id,txid,amount_c,method,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, txid, C(amt), method, 'pending', now).run()).meta.last_row_id } catch (e) { return J({ error: 'txid_used' }, 409) }
    const ok = method === 'telebirr' && await tryMatch(env, txid);
    if (!ok) await notifyAdmins(env, depositText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, txid }), [[{ text: '✅ Approve', callback_data: 'da:' + id }, { text: '❌ Reject', callback_data: 'dr:' + id }]]);
    return J({ status: ok ? 'approved' : 'pending', balance: B((await db.prepare('SELECT balance FROM users WHERE id=?').bind(u.id).first()).balance) });
  }
  if (p === '/api/withdraw') {
    const amt = Number(b.amount), account = String(b.account || '').trim().slice(0, 40), method = String(b.method || 'telebirr').slice(0, 20);
    if (!(amt >= MIN_WD) || !account) return J({ error: 'bad_input', min: MIN_WD }, 400);
    if (!(await db.prepare("SELECT 1 x FROM deposits WHERE user_id=? AND status='approved' LIMIT 1").bind(u.id).first())) return J({ error: 'deposit_required' }, 403); // bonus-farming guard: deposit once before withdrawing
    let id; try { const r = await db.batch([db.prepare('UPDATE users SET balance=balance-?2 WHERE id=?1').bind(u.id, C(amt)), db.prepare('INSERT INTO withdrawals(user_id,amount_c,method,account,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, C(amt), method, account, 'pending', now)]); id = r[1].meta.last_row_id } catch (e) { return J({ error: errOf(e) }, 409) }
    await notifyAdmins(env, withdrawText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, account }), [[{ text: '💸 Mark paid', callback_data: 'wp:' + id }, { text: '↩️ Reject', callback_data: 'wr:' + id }]]);
    return J({ status: 'pending' });
  }
  return J({ error: 'not_found' }, 404);
}
export default {
  async fetch(req, env) {
    const cors = { 'access-control-allow-origin': env.ALLOW_ORIGIN || '*', 'access-control-allow-headers': 'content-type,x-init-data,x-admin-key', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    let res; try { res = await route(req, env, new URL(req.url)) } catch (e) { res = J({ error: 'server_error', detail: String(e.message || e) }, 500) }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); return res;
  }
};
