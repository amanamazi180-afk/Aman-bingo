// Aman Bingo server — Cloudflare Worker + D1 database.
// Money is stored in cents (birr x 100). Variables to set in Cloudflare:
//   BOT_TOKEN, ADMIN_TG_ID, SMS_SECRET, TG_SECRET (secrets) · GAME_URL, ALLOW_ORIGIN, STAKE (plain variables)
const LOBBY_MS = 40000, CALL_MS = 4000, REST_MS = 8000, CUT = 0.8, MAXC = 2, TOTAL = 400, MIN_DEP = 30, MAX_DEP = 50000, MIN_WD = 50;
const C = x => Math.round(Number(x) * 100), B = c => c / 100;
const REG_BONUS_C = C(10); // one-time registration gift (stake money). The daily 08:00 bonus is switched off.
const bonusC = env => REG_BONUS_C; // most bonus a player can hold (used when refunding stakes)
const refreshBonus = () => Promise.resolve(); // daily bonus reset removed
const AUTO_MAX_C = C(1000), DASHEN_WINDOW_MS = 30 * 60 * 1000; // Dashen deposits above 1000 birr, or unclear matches, still need your approval
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
export function parseDashen(t) { // Dashen Bank "credited" message (it has no transaction id, so we match by amount + sender phone + time)
  t = String(t || '');
  const a = t.match(/credited with ETB\s*([\d,]+(?:\.\d+)?)/i);
  if (!a || !/Dashen/i.test(t)) return null;
  const ph = t.match(/Phone Number:\s*(\+?\d{9,13})/i), dt = t.match(/on\s+(\d{2}\/\d{2}\/\d{4})\s+at\s+(\d{2}:\d{2}:\d{2}\s*[AP]M)/i);
  return { amount_c: C(a[1].replace(/,/g, '')), phone: ph ? normPhone(ph[1]) : null, stamp: dt ? dt[1] + ' ' + dt[2] : null };
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
const say = (env, chat, text, kb) => tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: kb ? { inline_keyboard: kb } : undefined });
const playKb = env => [[{ text: 'ይጫወቱ 🎮', web_app: { url: env.GAME_URL } }]];

/* ---------- bottom menu keyboard (Play Games / Deposit / Check Balance / Support) ---------- */
const SUPPORT_URL = 'https://t.me/Amanbing2';
const contactKb = { keyboard: [[{ text: '📞 Share contact', request_contact: true }]], resize_keyboard: true, is_persistent: true };
const mainKb = { keyboard: [[{ text: '🎮 Play Games' }, { text: '💰 Deposit' }], [{ text: '💲 Check Balance' }, { text: '🧑‍💻 Support' }]], resize_keyboard: true, is_persistent: true };
const BTN = { '🎮 Play Games': '/play', '💰 Deposit': '/deposit', '💲 Check Balance': '/balance', '🧑‍💻 Support': '/support' };
const PAY = { // payment accounts shown to players (callback keys: t, b, d)
  t: { name: 'Telebirr', acc: '0958828304', holder: 'Amanuel' },
  b: { name: 'BOA', acc: '266199511', holder: 'Amanuel Yismah' },
  d: { name: 'Dashen Bank', acc: '5901914597011', holder: 'Amanuel Yismah' } };
const TXID_RE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,14}\b/i; // a transaction id: 8-14 letters/digits with at least one digit
let ctxReady = false;
const ensureCtx = async env => { if (ctxReady) return; await env.DB.prepare('CREATE TABLE IF NOT EXISTS deposit_ctx(user_id INTEGER PRIMARY KEY, amount_c INTEGER, method TEXT, ts INTEGER)').run(); ctxReady = true };
const sayMenu = (env, chat, text) => tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: mainKb }); // plain text reply that keeps the 4 buttons on screen

/* ---------- money operations (each is one atomic batch) ---------- */
async function tryMatch(env, txid) { // credit a pending deposit when a matching unclaimed SMS exists
  const db = env.DB;
  const r = await db.batch([
    db.prepare("UPDATE users SET balance=balance+(SELECT d.amount_c FROM deposits d WHERE d.txid=?1) WHERE id=(SELECT d.user_id FROM deposits d JOIN sms_log s ON s.txid=d.txid WHERE d.txid=?1 AND d.status='pending' AND s.claimed=0 AND s.amount_c=d.amount_c)").bind(txid),
    db.prepare("UPDATE deposits SET status='approved',note='auto' WHERE txid=?1 AND status='pending' AND EXISTS(SELECT 1 FROM sms_log s WHERE s.txid=?1 AND s.claimed=0 AND s.amount_c=deposits.amount_c)").bind(txid),
    db.prepare("UPDATE sms_log SET claimed=1 WHERE txid=?1 AND claimed=0 AND EXISTS(SELECT 1 FROM deposits d WHERE d.txid=?1 AND d.status='approved')").bind(txid)]);
  if (r[1].meta.changes > 0) { const d = await db.prepare('SELECT user_id,amount_c FROM deposits WHERE txid=?').bind(txid).first(); say(env, d.user_id, `✅ የ${B(d.amount_c)} ብር ዲፖዚት ደርሷል።`, playKb(env)); return true }
  return false;
}
async function approveWithSms(env, depId, smsTx) {
  const db = env.DB;
  const r = await db.batch([
    db.prepare("UPDATE users SET balance=balance+(SELECT d.amount_c FROM deposits d WHERE d.id=?1) WHERE id=(SELECT d.user_id FROM deposits d JOIN sms_log s ON s.txid=?2 WHERE d.id=?1 AND d.status='pending' AND s.claimed=0 AND s.amount_c=d.amount_c)").bind(depId, smsTx),
    db.prepare("UPDATE deposits SET status='approved',note='auto' WHERE id=?1 AND status='pending' AND EXISTS(SELECT 1 FROM sms_log s WHERE s.txid=?2 AND s.claimed=0 AND s.amount_c=deposits.amount_c)").bind(depId, smsTx),
    db.prepare("UPDATE sms_log SET claimed=1 WHERE txid=?1 AND claimed=0 AND EXISTS(SELECT 1 FROM deposits d WHERE d.id=?2 AND d.status='approved' AND d.note='auto')").bind(smsTx, depId)]);
  if (r[1].meta.changes > 0) { const d = await db.prepare('SELECT user_id,amount_c FROM deposits WHERE id=?').bind(depId).first(); say(env, d.user_id, `✅ የ${B(d.amount_c)} ብር ዲፖዚት ደርሷል።`, playKb(env)); return true }
  return false;
}
async function tryMatchDashen(env, smsTx, amount_c, phone) { // a Dashen SMS arrived: credit the one waiting Dashen deposit of the same amount
  if (amount_c > AUTO_MAX_C) return false;
  const c = (await env.DB.prepare("SELECT d.id,u.phone FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.method='dashen' AND d.status='pending' AND d.amount_c=?1 AND d.ts>=?2").bind(amount_c, Date.now() - DASHEN_WINDOW_MS).all()).results;
  const ok = phone ? c.filter(x => x.phone === phone) : c;
  return ok.length === 1 && c.length === 1 ? approveWithSms(env, ok[0].id, smsTx) : false;
}
async function tryMatchDashenDeposit(env, depId) { // a Dashen deposit was submitted: look for an unclaimed Dashen SMS of the same amount
  const db = env.DB, d = await db.prepare("SELECT d.*,u.phone uphone FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.id=?").bind(depId).first();
  if (!d || d.method !== 'dashen' || d.status !== 'pending' || d.amount_c > AUTO_MAX_C) return false;
  const sms = (await db.prepare("SELECT txid,raw FROM sms_log WHERE txid LIKE 'DSN%' AND claimed=0 AND amount_c=?1 AND ts>=?2").bind(d.amount_c, Date.now() - DASHEN_WINDOW_MS).all()).results;
  const ok = sms.filter(x => { const p = parseDashen(x.raw); return !p || !p.phone || p.phone === d.uphone });
  const rivals = (await db.prepare("SELECT COUNT(*) n FROM deposits WHERE method='dashen' AND status='pending' AND amount_c=?1 AND ts>=?2").bind(d.amount_c, Date.now() - DASHEN_WINDOW_MS).first()).n;
  return ok.length === 1 && sms.length === 1 && rivals === 1 ? approveWithSms(env, depId, ok[0].txid) : false;
}
const autoMatch = (env, method, txid, id) => method === 'telebirr' ? tryMatch(env, txid) : method === 'dashen' ? tryMatchDashenDeposit(env, id) : false;
async function decideDeposit(env, id, ok) {
  const db = env.DB;
  const r = await db.batch(ok ? [
    db.prepare("UPDATE users SET balance=balance+(SELECT amount_c FROM deposits WHERE id=?1 AND status='pending') WHERE id=(SELECT user_id FROM deposits WHERE id=?1 AND status='pending')").bind(id),
    db.prepare("UPDATE deposits SET status='approved',note='admin' WHERE id=?1 AND status='pending'").bind(id)
  ] : [db.prepare("UPDATE deposits SET status='rejected',note='admin' WHERE id=?1 AND status='pending'").bind(id)]);
  const done = r[r.length - 1].meta.changes > 0;
  if (done) { const d = await db.prepare('SELECT user_id,amount_c FROM deposits WHERE id=?').bind(id).first(); say(env, d.user_id, ok ? `✅ የ${B(d.amount_c)} ብር ዲፖዚትዎ ተፈቅዷል።` : '❌ ዲፖዚትዎ ተቀባይነት አላገኘም። ድጋፍን ያነጋግሩ።', ok ? playKb(env) : undefined) }
  return done;
}
async function decideWithdraw(env, id, paid) {
  const db = env.DB;
  const r = await db.batch(paid ? [db.prepare("UPDATE withdrawals SET status='paid' WHERE id=?1 AND status='pending'").bind(id)] : [
    db.prepare("UPDATE users SET balance=balance+(SELECT amount_c FROM withdrawals WHERE id=?1 AND status='pending') WHERE id=(SELECT user_id FROM withdrawals WHERE id=?1 AND status='pending')").bind(id),
    db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?1 AND status='pending'").bind(id)]);
  const done = r[r.length - 1].meta.changes > 0;
  if (done) { const w = await db.prepare('SELECT user_id,amount_c FROM withdrawals WHERE id=?').bind(id).first(); say(env, w.user_id, paid ? `✅ ${B(w.amount_c)} ብር ተልኮልዎታል።` : `↩️ የወጪ ጥያቄዎ ውድቅ ሆኗል — ${B(w.amount_c)} ብር ወደ ሂሳብዎ ተመልሷል።`) }
  return done;
}

async function submitDeposit(env, u, amt, txidRaw, method) { // same logic as /api/deposit, used when the player pastes the transaction id in the bot
  const db = env.DB, now = Date.now(), txid = String(txidRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (txid.length < 8 || txid.length > 14) return 'bad_txid';
  let id; try { id = (await db.prepare('INSERT INTO deposits(user_id,txid,amount_c,method,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, txid, C(amt), method, 'pending', now).run()).meta.last_row_id } catch (e) { return 'txid_used' }
  const ok = await autoMatch(env, method, txid, id);
  if (!ok) await say(env, env.ADMIN_TG_ID, depositText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, txid }), [[{ text: '✅ Approve', callback_data: 'da:' + id }, { text: '❌ Reject', callback_data: 'dr:' + id }]]);
  return ok ? 'approved' : 'pending';
}

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
    await db.prepare("INSERT INTO rounds(start_ts,seed,status,stake_c) SELECT ?1,?2,'lobby',?3 WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE status IN('lobby','running'))").bind(now, rnd32(), C(env.STAKE || 10)).run();
    r = await latest(db);
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
async function stateFor(env, u) {
  const db = env.DB, r = await advance(env), now = Date.now();
  const picks = (await db.prepare('SELECT p.cartela,p.user_id,u.name FROM picks p JOIN users u ON u.id=p.user_id WHERE p.round_id=?').bind(r.id).all()).results;
  const n = r.status === 'running' ? callsAt(r, now) : r.status === 'ended' ? r.called_n : 0;
  const win = r.status === 'ended' ? JSON.parse(r.winners || '[]') : [];
  const me = await db.prepare('SELECT balance,bonus_c FROM users WHERE id=?').bind(u.id).first();
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

/* ---------- registration by sharing the Telegram contact ---------- */
const askContact = (env, uid, text = '👋 እንኳን ደህና መጡ! ለመጫወት እባክዎ እውቂያዎን (contact) ያጋሩ።') => tg(env, 'sendMessage', { chat_id: uid, text, reply_markup: contactKb });
async function onContact(env, m) {
  const db = env.DB, uid = m.from.id, c = m.contact;
  if (c.user_id !== uid) return askContact(env, uid, '❌ እባክዎ ከታች ያለውን ቁልፍ ተጠቅመው የራስዎን እውቂያ ያጋሩ።');
  const ph = normPhone(c.phone_number);
  if (!ph) return askContact(env, uid, '❌ የኢትዮጵያ ስልክ ቁጥሮች (+251) ብቻ መመዝገብ ይችላሉ።');
  await db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(uid, m.from.first_name || 'player', Date.now()).run();
  const ex = await db.prepare('SELECT phone FROM users WHERE id=?').bind(uid).first();
  const fresh = !ex.phone;
  if (fresh) { try { await db.prepare("UPDATE users SET name=?,phone=?,bonus_c=?,balance=0 WHERE id=? AND (phone IS NULL OR phone='')").bind(m.from.first_name || 'player', ph, REG_BONUS_C, uid).run() } catch (e) { return askContact(env, uid, '❌ ይህ ስልክ ቁጥር በሌላ አካውንት ተመዝግቧል።') } }
  await say(env, uid, fresh ? '✅ ተመዝግበዋል! የ 10 ብር ስጦታ ተሰጥቶዎታል።' : '✅ ቀድሞውኑ ተመዝግበዋል። እንኳን በደህና ተመለሱ!', playKb(env));
  return tg(env, 'sendMessage', { chat_id: uid, text: 'ከታች ያለውን ምናሌ ይጠቀሙ 👇', reply_markup: mainKb });
}

/* ---------- Telegram bot (commands + admin buttons) ---------- */
async function onTelegram(env, up) {
  const db = env.DB, admin = String(env.ADMIN_TG_ID);
  if (up.callback_query) {
    const q = up.callback_query, [a, id] = String(q.data).split(':');
    if (a === 'pm') { // any player picked a payment method
      const P = PAY[id], amt = Number(String(q.data).split(':')[2]);
      await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
      if (!P || !(amt >= MIN_DEP)) return;
      await ensureCtx(env);
      await db.prepare('INSERT OR REPLACE INTO deposit_ctx(user_id,amount_c,method,ts) VALUES(?,?,?,?)').bind(q.from.id, C(amt), { t: 'telebirr', b: 'boa', d: 'dashen' }[id], Date.now()).run();
      return sayMenu(env, q.from.id, `💰 ${amt} ብር በ${P.name} ዲፖዚት\n\nአካውንት: ${P.acc}\nስም: ${P.holder}\n\n1. ${amt} ብር ወደዚህ አካውንት ይላኩ።\n2. ከዚያ የግብይት ቁጥሩን (Transaction ID) እዚህ ቻት ላይ ይለጥፉ 👇`);
    }
    if (String(q.from.id) !== admin) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Admin only' });
    const ok = a === 'da' ? await decideDeposit(env, +id, true) : a === 'dr' ? await decideDeposit(env, +id, false) : a === 'wp' ? await decideWithdraw(env, +id, true) : a === 'wr' ? await decideWithdraw(env, +id, false) : false;
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: ok ? 'Done' : 'Already processed' });
    return tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: q.message.text + (ok ? '\n\n✔ Done' : '\n\n(already processed)') });
  }
  const m = up.message; if (!m) return;
  if (m.contact) return onContact(env, m);
  if (!m.text) return;
  const cmd = BTN[m.text.trim()] || m.text.split(/[\s@]/)[0].toLowerCase(), uid = m.from.id; await refreshBonus(env, uid, Date.now()); const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
  if ((!u || !u.phone) && String(uid) !== admin) return askContact(env, uid); // new players must share their contact first
  if (cmd === '/balance') return u ? sayMenu(env, uid, `💰 ቀሪ ሂሳብ: ${B(u.balance).toFixed(2)} ETB`) : say(env, uid, 'ለመመዝገብ እባክዎ ጨዋታውን ይክፈቱ።', playKb(env));
  if (cmd === '/pending' && String(uid) === admin) {
    const d = (await db.prepare("SELECT d.*,u.name,u.phone FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.status='pending'").all()).results, w = (await db.prepare("SELECT w.*,u.name,u.phone FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending'").all()).results;
    if (!d.length && !w.length) return say(env, uid, 'Nothing pending ✅');
    for (const x of d) await say(env, uid, depositText(x), [[{ text: '✅ Approve', callback_data: 'da:' + x.id }, { text: '❌ Reject', callback_data: 'dr:' + x.id }]]);
    for (const x of w) await say(env, uid, withdrawText(x), [[{ text: '💸 Mark paid', callback_data: 'wp:' + x.id }, { text: '↩️ Reject', callback_data: 'wr:' + x.id }]]);
    return;
  }
  if (cmd === '/deposit') return sayMenu(env, uid, `💰 ዲፖዚት የሚያደርጉትን መጠን በቁጥር ያስገቡ\n\nዝቅተኛ: ${MIN_DEP} ብር\nከፍተኛ: ${MAX_DEP} ብር`);
  const txt = m.text.trim(), tm = !txt.startsWith('/') && !/^\d{1,7}(\.\d+)?$/.test(txt) && txt.match(TXID_RE);
  if (tm) { // player pasted a transaction id
    await ensureCtx(env);
    const pc = await db.prepare('SELECT * FROM deposit_ctx WHERE user_id=?').bind(uid).first();
    if (!pc || Date.now() - pc.ts > 36e5) return sayMenu(env, uid, '💰 ዲፖዚት ለማድረግ፡ Deposit ይንኩ፣ መጠኑን ያስገቡ፣ የክፍያ መንገድ ይምረጡ፣ ገንዘቡን ይላኩ፣ ከዚያ የግብይት ቁጥሩን እዚህ ይለጥፉ።');
    if (!u || !u.phone) return say(env, uid, 'ለመመዝገብ እባክዎ ጨዋታውን ይክፈቱ።', playKb(env));
    const r = await submitDeposit(env, u, B(pc.amount_c), tm[0], pc.method);
    if (r === 'bad_txid') return sayMenu(env, uid, '❌ ይህ የግብይት ቁጥር አይመስልም። ከክፍያ መልእክትዎ ላይ ቁጥሩን ይለጥፉ።');
    if (r === 'txid_used') return sayMenu(env, uid, '❌ ይህ የግብይት ቁጥር ቀድሞ ጥቅም ላይ ውሏል። ቁጥሩን አረጋግጠው ትክክለኛውን ይለጥፉ።');
    await db.prepare('DELETE FROM deposit_ctx WHERE user_id=?').bind(uid).run();
    if (r === 'approved') { const nu = await db.prepare('SELECT balance FROM users WHERE id=?').bind(uid).first(); return sayMenu(env, uid, `💰 ቀሪ ሂሳብ: ${B(nu.balance).toFixed(2)} ETB`) }
    return sayMenu(env, uid, `✅ የ${B(pc.amount_c)} ብር ዲፖዚት ጥያቄዎ ደርሶናል። ክፍያውን ካረጋገጥን በኋላ ሂሳብዎ ላይ ይጨመራል (ብዙውን ጊዜ ጥቂት ደቂቃዎች)።`);
  }
  if (/^\d+(\.\d+)?$/.test(txt)) { // user typed an amount
    const amt = Number(txt);
    if (amt > MAX_DEP) return sayMenu(env, uid, `❌ ከፍተኛው የዲፖዚት መጠን ${MAX_DEP} ብር ነው። ከ${MIN_DEP} እስከ ${MAX_DEP} ብር ያስገቡ።`);
    if (amt < MIN_DEP) return sayMenu(env, uid, `❌ ዝቅተኛው የዲፖዚት መጠን ${MIN_DEP} ብር ነው። ${MIN_DEP} ወይም ከዚያ በላይ ያስገቡ።`);
    return say(env, uid, `💰 ዲፖዚት ${amt} ብር\n\nየሚልኩበትን የክፍያ መንገድ ይምረጡ 👇`, [
      [{ text: 'Telebirr', callback_data: 'pm:t:' + amt }],
      [{ text: 'BOA', callback_data: 'pm:b:' + amt }],
      [{ text: 'Dashen Bank', callback_data: 'pm:d:' + amt }]]);
  }
  if (cmd === '/start') {
    await say(env, uid, 'እንኳን ወደ አማን ቢንጎ በደህና መጡ! ለመጀመር ይጫወቱ የሚለውን ይንኩ።', playKb(env));
    return tg(env, 'sendMessage', { chat_id: uid, text: 'ከታች ያለውን ምናሌ ይጠቀሙ 👇', reply_markup: mainKb });
  }
  if (cmd === '/play') return say(env, uid, 'ለመጫወት ከታች ይንኩ! 🎮', [[{ text: 'ጨዋታውን ክፈት 🎮', web_app: { url: env.GAME_URL } }]]);
  if (cmd === '/support') return say(env, uid, 'እርዳታ ይፈልጋሉ? የደንበኛ አገልግሎታችንን ያግኙ 👇', [[{ text: '🧑‍💻 ድጋፍ ያግኙ', url: SUPPORT_URL }]]);
  const hint = { '/register': 'ለመመዝገብ', '/deposit': 'ዲፖዚት ለማድረግ', '/withdraw': 'ገንዘብ ለማውጣት', '/transfer': 'ለማስተላለፍ', '/invite': 'ጓደኞችን ለመጋበዝ', '/instruction': 'መመሪያውን ለማንበብ' }[cmd];
  if (hint) return say(env, uid, `${hint} ጨዋታውን ይክፈቱ።`, playKb(env));
  await say(env, uid, 'እንኳን ወደ አማን ቢንጎ በደህና መጡ! ለመጀመር ይጫወቱ የሚለውን ይንኩ።', playKb(env));
  return tg(env, 'sendMessage', { chat_id: uid, text: 'ከታች ያለውን ምናሌ ይጠቀሙ 👇', reply_markup: mainKb });
}
const depositText = x => `💰 Deposit #${x.id}\n${x.name} · ${x.phone}\nAmount: ${B(x.amount_c)} birr via ${x.method}\nTransaction: ${x.txid}\nNo matching SMS yet — approve only if the money arrived.`;
const withdrawText = x => `💸 Withdrawal #${x.id}\n${x.name} · ${x.phone}\nAmount: ${B(x.amount_c)} birr\nSend to: ${x.method} ${x.account}`;

/* ---------- HTTP routes ---------- */
const errOf = e => /CHECK/.test(e.message) ? 'insufficient_balance' : /UNIQUE|PRIMARY/.test(e.message) ? 'taken' : 'server_error';
async function route(req, env, url) {
  const p = url.pathname, db = env.DB, now = Date.now();
  if (p === '/') return J({ ok: true });
  if (p === '/sms' && req.method === 'POST') { // phone forwards incoming Telebirr SMS here
    if (req.headers.get('x-secret') !== env.SMS_SECRET) return J({ error: 'forbidden' }, 403);
    const raw = await req.text(); let text = raw; try { const o = JSON.parse(raw); text = o.text || o.message || o.body || o.content || raw } catch (e) { }
    const s = parseSms(text);
    if (!s) {
      const ds = parseDashen(text); if (!ds) return J({ ok: true, parsed: false });
      const tx = 'DSN' + (ds.stamp || String(now)).replace(/\D/g, '') + ds.amount_c;
      await db.prepare('INSERT OR IGNORE INTO sms_log(txid,amount_c,raw,ts) VALUES(?,?,?,?)').bind(tx, ds.amount_c, String(text).slice(0, 500), now).run();
      await tryMatchDashen(env, tx, ds.amount_c, ds.phone); return J({ ok: true, parsed: true });
    }
    await db.prepare('INSERT OR IGNORE INTO sms_log(txid,amount_c,raw,ts) VALUES(?,?,?,?)').bind(s.txid, s.amount_c, String(text).slice(0, 500), now).run();
    await tryMatch(env, s.txid); return J({ ok: true, parsed: true });
  }
  if (p === '/tg/' + env.TG_SECRET && req.method === 'POST') { await onTelegram(env, await req.json()); return J({ ok: true }) }
  if (!p.startsWith('/api/')) return J({ error: 'not_found' }, 404);
  const tu = await verifyInit(req.headers.get('x-init-data'), env.BOT_TOKEN); if (!tu) return J({ error: 'unauthorized' }, 401);
  await db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(tu.id, tu.first_name || 'player', now).run();
  await refreshBonus(env, tu.id, now);
  const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(tu.id).first(), b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const need = () => u.phone ? null : J({ error: 'not_registered' }, 403);
  if (p === '/api/me') { const dep = (await db.prepare('SELECT amount_c,status,ts FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results, wd = (await db.prepare('SELECT amount_c,status,ts FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results; return J({ id: u.id, name: u.name, phone: u.phone, registered: !!u.phone, balance: B(u.balance), bonus: B(u.bonus_c), deposits: dep.map(x => ({ ...x, amount: B(x.amount_c) })), withdrawals: wd.map(x => ({ ...x, amount: B(x.amount_c) })) }) }
  if (p === '/api/register') { if (u.phone) return J({ error: 'already_registered' }, 409); const ph = normPhone(b.phone), nm = String(b.name || '').trim().slice(0, 30); if (!ph || nm.length < 2) return J({ error: 'bad_input' }, 400);
    try { await db.prepare('UPDATE users SET name=?,phone=?,bonus_c=?,balance=0 WHERE id=?').bind(nm, ph, REG_BONUS_C, u.id).run() } catch (e) { return J({ error: 'phone_used' }, 409) } return J({ ok: true }) }
  if (p === '/api/state') return J(await stateFor(env, u));
  if (p === '/api/leaderboard') return J(await leaderboard(env, u, url.searchParams.get('period')));
  const bad = need(); if (bad) return bad;
  if (p === '/api/pick' || p === '/api/unpick') {
    const r = await advance(env), no = Math.floor(Number(b.cartela)); if (!(no >= 1 && no <= TOTAL)) return J({ error: 'bad_input' }, 400);
    if (r.status !== 'lobby' || now - r.start_ts >= LOBBY_MS) return J({ error: 'round_closed' }, 409);
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
    return J(await stateFor(env, u));
  }
  if (p === '/api/deposit') {
    const amt = Number(b.amount), txid = String(b.txid || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), method = ['boa', 'dashen'].includes(b.method) ? b.method : 'telebirr';
    if (!(amt >= MIN_DEP) || txid.length < 8 || txid.length > 14) return J({ error: 'bad_input', min: MIN_DEP }, 400);
    let id; try { id = (await db.prepare('INSERT INTO deposits(user_id,txid,amount_c,method,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, txid, C(amt), method, 'pending', now).run()).meta.last_row_id } catch (e) { return J({ error: 'txid_used' }, 409) }
    const ok = await autoMatch(env, method, txid, id);
    if (!ok) await say(env, env.ADMIN_TG_ID, depositText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, txid }), [[{ text: '✅ Approve', callback_data: 'da:' + id }, { text: '❌ Reject', callback_data: 'dr:' + id }]]);
    return J({ status: ok ? 'approved' : 'pending', balance: B((await db.prepare('SELECT balance FROM users WHERE id=?').bind(u.id).first()).balance) });
  }
  if (p === '/api/withdraw') {
    const amt = Number(b.amount), acct = String(b.account || '').trim().slice(0, 40), hn = String(b.name || '').trim().slice(0, 40), account = acct + ' · ' + hn, method = String(b.method || 'telebirr').slice(0, 20);
    if (!(amt >= MIN_WD) || !acct || hn.length < 3) return J({ error: 'bad_input', min: MIN_WD }, 400);
    if (await db.prepare("SELECT 1 x FROM withdrawals WHERE user_id=? AND status='pending' LIMIT 1").bind(u.id).first()) return J({ error: 'withdraw_pending' }, 409); // one pending withdrawal at a time
    if (!(await db.prepare("SELECT 1 x FROM deposits WHERE user_id=? AND status='approved' LIMIT 1").bind(u.id).first())) return J({ error: 'deposit_required' }, 403); // bonus-farming guard: deposit once before withdrawing
    let id; try { const r = await db.batch([db.prepare('UPDATE users SET balance=balance-?2 WHERE id=?1').bind(u.id, C(amt)), db.prepare('INSERT INTO withdrawals(user_id,amount_c,method,account,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, C(amt), method, account, 'pending', now)]); id = r[1].meta.last_row_id } catch (e) { return J({ error: errOf(e) }, 409) }
    await say(env, env.ADMIN_TG_ID, withdrawText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, account }), [[{ text: '💸 Mark paid', callback_data: 'wp:' + id }, { text: '↩️ Reject', callback_data: 'wr:' + id }]]);
    return J({ status: 'pending' });
  }
  return J({ error: 'not_found' }, 404);
}
export default {
  async fetch(req, env) {
    const cors = { 'access-control-allow-origin': env.ALLOW_ORIGIN || '*', 'access-control-allow-headers': 'content-type,x-init-data', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    let res; try { res = await route(req, env, new URL(req.url)) } catch (e) { res = J({ error: 'server_error', detail: String(e.message || e) }, 500) }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); return res;
  }
};
