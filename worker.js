// Aman Bingo server — Cloudflare Worker + D1 database + one Durable Object (GameHub) that runs the live game.
// Money is stored in cents (birr x 100). Variables to set in Cloudflare:
//   BOT_TOKEN, ADMIN_TG_ID, SMS_SECRET, TG_SECRET, ADMIN_KEY (secrets) · GAME_URL, ALLOW_ORIGIN, STAKE (plain variables)
//   Optional: CBE_ACCOUNT (e.g. "1000123456789 (AMANUEL YISMAH)" — the CBE button appears only when this is set), BOT_USERNAME, WELCOME_BONUS, DAILY_BONUS, ADMIN_URL, PROMO_PHOTO
// wrangler.json needs the HUB binding + migration for GameHub (see the two blocks given with this file).
// Deposit verification: the player pastes the bank SMS in the bot. The Worker reads the amount + transaction number (Telebirr, Dashen, BOA, CBE)
// and credits the balance automatically when the SAME SMS was forwarded to POST /sms by the SMS-forwarder app on the receiving phone.
// If that SMS has not arrived yet, the deposit waits (and is also sent to the admins) and is credited the moment the SMS arrives.
import { DurableObject } from 'cloudflare:workers';
const LOBBY_MS = 40000, CALL_MS = 4000, REST_MS = 8000, CUT = 0.8, MAXC = 2, TOTAL = 400, MIN_DEP = 30, MIN_WD = 50, MIN_TR = 10;
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

/* ---------- deposit SMS reading: Telebirr, Dashen, BOA, CBE ---------- */
const toNum = s => Number(String(s).replace(/,/g, ''));
const FT = s => String(s).toUpperCase().slice(0, 12); // bank references (FT…) are keyed by their first 12 characters, so a receipt link and a feedback link of the same payment give the same id
// Reads a "money received" SMS. Returns { bank, amount_c, txid } or null (money-sent messages and anything else are ignored).
//  Telebirr: "… 300.00 ብር በ 10/10/2026 11:14:57 ተቀብለዋል። የሂሳብ እንቅስቃሴ ቁጥርዎ DJA8MMWD4O ነዉ።"
//  BOA:      "… was credited with ETB 50.00 by NAME … Receipt: https://cs.bankofabyssinia.com/slip/?trx=FT2627850CY910104"
//  Dashen 1: "You have received ETB 6,000.00 from NAME on 2026-09-29 at 09:48:09 with transaction reference: 112WDTS262720002." (has a reference number)
//  Dashen 2: "… credited with ETB 40.00 … on 05/10/2026 at 11:24:14 PM. Your current balance is ETB 303.20." (no reference number, so the id is built from date + time + balance)
//  CBE:      "… Credited with ETB … Ref No FT26283XXXXX …" (format not tested with a real sample yet)
export function parseBank(t) {
  t = String(t || '');
  let a, i, m;
  if (/ተቀብለዋል/.test(t)) { // Telebirr (Amharic)
    a = t.match(/([\d,]+(?:\.\d+)?)\s*ብር\s*በ\s*\d{2}\/\d{2}\/\d{4}/); i = t.match(/ቁጥርዎ\s+([A-Z0-9]{8,14})/i);
    if (a && i) return { bank: 'telebirr', amount_c: C(toNum(a[1])), txid: i[1].toUpperCase() };
  }
  a = t.match(/you\s+have\s+received\s+ETB\s*([\d,]+(?:\.\d+)?)/i); i = t.match(/transaction\s*(?:number|id|no\.?)\s*(?:is|:)?\s*([A-Z0-9]{8,14})/i);
  if (a && i) return { bank: 'telebirr', amount_c: C(toNum(a[1])), txid: i[1].toUpperCase() }; // Telebirr (English)
  a = t.match(/received\s+ETB\s*([\d,]+(?:\.\d+)?)/i); i = t.match(/transaction\s*reference\s*[:.]?\s*([A-Z0-9]{8,24})/i);
  if (a && i) return { bank: 'dashen', amount_c: C(toNum(a[1])), txid: i[1].toUpperCase() }; // Dashen "You have received ETB … with transaction reference: …"
  a = t.match(/credited\s+with\s+ETB\s*([\d,]+(?:\.\d+)?)/i); // Dashen, BOA and CBE all say "credited with ETB …"
  if (!a) return null;
  const amount_c = C(toNum(a[1]));
  m = t.match(/slip\/\s*\?trx=\s*([A-Z0-9]{8,24})/i) || t.match(/cs\/\s*\?trx=\s*[A-Z]?(FT[A-Z0-9]{8,22})/i); // BOA
  if (m) return { bank: 'boa', amount_c, txid: FT(m[1]) };
  m = t.match(/ref(?:erence)?\s*(?:no\.?|number)?\s*[:.]?\s*(FT[A-Z0-9]{8,22})/i) || t.match(/[?&]id=(FT[A-Z0-9]{8,22})/i); // CBE
  if (m) return { bank: 'cbe', amount_c, txid: FT(m[1]) };
  const dt = t.match(/(\d{2})\/(\d{2})\/(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP])M/i); // Dashen
  if (!dt) return null;
  const bal = t.match(/balance\s+is\s+ETB\s*([\d,]+(?:\.\d+)?)/i);
  return { bank: 'dashen', amount_c, txid: ('DSH' + dt[1] + dt[2] + dt[3] + dt[4].padStart(2, '0') + dt[5] + dt[6] + dt[7] + (bal ? C(toNum(bal[1])) : 0)).toUpperCase() };
}
export const parseSms = parseBank; // the SMS-forwarder route uses the same reader
// reads the payment message a player pastes in the bot: a known bank SMS gives bank + amount + transaction number; anything else just looks for a transaction number
export function parsePaste(t) {
  t = String(t || '');
  const b = parseBank(t); if (b) return b;
  const lab = t.match(/(?:transaction\s*(?:number|id|no\.?)|ref(?:erence)?(?:\s*(?:no\.?|number|id))?|receipt\s*(?:no\.?|number)|ቁጥርዎ|ቁጥር)\s*(?:is|:|-)?\s*([A-Z0-9]{8,20})\b/i);
  if (lab && /\d/.test(lab[1]) && /[A-Z]/i.test(lab[1])) return { txid: lab[1].toUpperCase() };
  const all = (t.toUpperCase().match(/\b[A-Z0-9]{8,20}\b/g) || []).filter(x => /\d/.test(x) && /[A-Z]/.test(x));
  return all.length ? { txid: all[0] } : null;
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

/* ---------- bot menu (inline buttons, like DIL BINGO) and Amharic texts ---------- */
const SUPPORT = '@Amanbing2';
const BTN = { play: '🎮 ጨዋታ ተጫወት', dep: '💰 ገንዘብ አስገባ', bal: '💳 ቀሪ ሂሳብ', sup: '🆘 እርዳታ' }; // old bottom-keyboard texts, still understood
const sendTo = (env, chat, text, markup) => tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: markup });
const SHARE_KB = { keyboard: [[{ text: '📱 ስልክ ቁጥሬን አጋራ', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const menuKb = env => [
  [{ text: 'Play 🎮', web_app: { url: env.GAME_URL } }],
  [{ text: 'Balance 💵', callback_data: 'm:bal' }, { text: 'Deposit 💰', callback_data: 'm:dep' }],
  [{ text: 'Contact Support... 🆘', url: 'https://t.me/' + SUPPORT.slice(1) }, { text: 'Instruction 📖', callback_data: 'm:ins' }],
  [{ text: 'Transfer 🎁', callback_data: 'm:tr' }, { text: 'Withdraw 🤑', callback_data: 'm:wd' }],
  [{ text: 'Invite 🔗', callback_data: 'm:inv' }]];
const sendMenu = (env, chat, text) => say(env, chat, text, menuKb(env));
const askContact = (env, uid) => sendTo(env, uid, '👋 እንኳን ወደ አማን ቢንጎ በደህና መጡ!\n\nለመመዝገብ ከታች ያለውን «📱 ስልክ ቁጥሬን አጋራ» ቁልፍ ይጫኑ።' + (welcomeC(env) > 0 ? `\n🎁 ሲመዘገቡ ${B(welcomeC(env))} ብር ስጦታ ያገኛሉ!` : ''), SHARE_KB);
const instructionText = `📖 እንዴት ይጫወታሉ?\n\n1️⃣ «Deposit» ን ተጭነው ገንዘብ ያስገቡ (ቢያንስ ${MIN_DEP} ብር)።\n2️⃣ «Play» ን ተጭነው ጨዋታውን ይክፈቱ።\n3️⃣ ከ1 እስከ ${TOTAL} ካርቴላ ይምረጡ — እስከ ${MAXC} ካርቴላ መያዝ ይቻላል።\n4️⃣ ቁጥሮች ሲጠሩ ካርዱ ላይ ምልክት ይደረጋል። መስመር (ወደጎን፣ ወደታች ወይም ዲያጎናል) የሞላ ካርቴላ ያሸንፋል።\n5️⃣ አሸናፊው ከጠቅላላው ድርሻ ${Math.round(CUT * 100)}% ያገኛል። ጨዋታ ለመጀመር ቢያንስ 2 ተጫዋች ያስፈልጋል።\n6️⃣ ለማውጣት «Withdraw» ን ይጫኑ (ቢያንስ ${MIN_WD} ብር)።\n\nጥያቄ ካለዎት: ${SUPPORT}`;

// banks offered in the deposit / withdraw flows (the CBE button shows only when CBE_ACCOUNT is set)
const BANKS = { telebirr: 'TELEBIRR', cbe: 'CBE BIRR', boa: 'BOA', dashen: 'DASHEN' };
const banksFor = env => Object.keys(BANKS).filter(k => k !== 'cbe' || env.CBE_ACCOUNT);
const bankKb = (env, flow) => {
  const b = banksFor(env).map(k => ({ text: BANKS[k], callback_data: `b:${flow}:${k}` })), rows = [];
  for (let i = 0; i < b.length; i += 2) rows.push(b.slice(i, i + 2));
  rows.push([{ text: '❌ ሰርዝ (Cancel)', callback_data: 'b:x' }]);
  return { inline_keyboard: rows };
};
const acctText = (env, k) => k === 'telebirr' ? '📱 Telebirr: 0958828304\n👤 Name: AMANUEL' : k === 'boa' ? '🏦 BOA: 266199511\n👤 Name: AMANUEL YISMAH' : k === 'dashen' ? '🏦 Dashen: 5901914597011\n👤 Name: AMANUEL YISMAH' : '🏦 CBE: ' + (env.CBE_ACCOUNT || '');

// where a player is in a multi-step flow (deposit / withdraw / transfer); expires after 30 minutes
const setState = (env, uid, step, data) => env.DB.prepare('INSERT INTO bot_state(uid,step,data,ts) VALUES(?1,?2,?3,?4) ON CONFLICT(uid) DO UPDATE SET step=?2,data=?3,ts=?4').bind(uid, step, JSON.stringify(data || {}), Date.now()).run();
const getState = async (env, uid) => { const r = await env.DB.prepare('SELECT step,data,ts FROM bot_state WHERE uid=?').bind(uid).first(); if (!r || Date.now() - r.ts > 30 * 60 * 1000) return null; let d = {}; try { d = JSON.parse(r.data || '{}') } catch (e) { } return { ...d, step: r.step } };
const clearState = (env, uid) => env.DB.prepare('DELETE FROM bot_state WHERE uid=?').bind(uid).run();
const hasDeposit = async (env, uid) => !!(await env.DB.prepare("SELECT 1 x FROM deposits WHERE user_id=? AND status='approved' LIMIT 1").bind(uid).first());

async function onContact(env, m) { // the player shared their phone number: register and give the welcome bonus
  const db = env.DB, uid = m.from.id, c = m.contact, now = Date.now();
  if (c.user_id && Number(c.user_id) !== Number(uid)) return sendTo(env, uid, '⚠️ እባክዎ የራስዎን ስልክ ቁጥር ብቻ ያጋሩ።', SHARE_KB);
  const ph = normPhone(c.phone_number);
  if (!ph) return sendTo(env, uid, '⚠️ ይህ ስልክ ቁጥር ትክክል አይደለም። የኢትዮጵያ ቁጥር (09… ወይም 07…) ያስፈልጋል።', SHARE_KB);
  const nm = String(c.first_name || m.from.first_name || 'player').trim().slice(0, 30) || 'player';
  await db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(uid, nm, now).run();
  const u = await db.prepare('SELECT phone FROM users WHERE id=?').bind(uid).first();
  if (u && u.phone) return sendMenu(env, uid, '✅ አስቀድመው ተመዝግበዋል።');
  let ok = false;
  try { ok = (await db.prepare("UPDATE users SET name=?1,phone=?2,balance=balance+?3 WHERE id=?4 AND (phone IS NULL OR phone='')").bind(nm, ph, welcomeC(env), uid).run()).meta.changes > 0 }
  catch (e) { return sendTo(env, uid, `⚠️ ይህ ስልክ ቁጥር በሌላ አካውንት ተመዝግቧል። ለእርዳታ ${SUPPORT} ያነጋግሩ።`, SHARE_KB) }
  if (!ok) return sendMenu(env, uid, '✅ አስቀድመው ተመዝግበዋል።');
  return sendMenu(env, uid, '✅ ተመዝግበዋል!' + (welcomeC(env) > 0 ? ` የ ${B(welcomeC(env))} ብር ስጦታ ተሰጥቶዎታል።` : '') + '\n\nለመጫወት «Play» ን ይጫኑ።');
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
// a deposit request (from the app or from the bot): auto-credited when a matching bank SMS (same transaction number and amount) was already forwarded to /sms, otherwise sent to the admins and credited the moment the SMS arrives
async function makeDeposit(env, u, amt, txid, method) {
  const db = env.DB, now = Date.now(); let id;
  try { id = (await db.prepare('INSERT INTO deposits(user_id,txid,amount_c,method,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, txid, C(amt), method, 'pending', now).run()).meta.last_row_id } catch (e) { return { error: 'txid_used' } }
  const ok = await tryMatch(env, txid);
  if (!ok) await notifyAdmins(env, depositText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, txid }), [[{ text: '✅ Approve', callback_data: 'da:' + id }, { text: '❌ Reject', callback_data: 'dr:' + id }]]);
  return { status: ok ? 'approved' : 'pending', id };
}
// a withdrawal request: balance is taken now and given back if an admin rejects it
async function makeWithdrawal(env, u, amt, account, method) {
  const db = env.DB, now = Date.now(); method = String(method || 'telebirr').slice(0, 20);
  if (!(await hasDeposit(env, u.id))) return { error: 'deposit_required' }; // bonus-farming guard: deposit once before withdrawing
  let id; try { const r = await db.batch([db.prepare('UPDATE users SET balance=balance-?2 WHERE id=?1').bind(u.id, C(amt)), db.prepare('INSERT INTO withdrawals(user_id,amount_c,method,account,status,ts) VALUES(?,?,?,?,?,?)').bind(u.id, C(amt), method, account, 'pending', now)]); id = r[1].meta.last_row_id } catch (e) { return { error: errOf(e) } }
  await notifyAdmins(env, withdrawText({ id, name: u.name, phone: u.phone, amount_c: C(amt), method, account }), [[{ text: '💸 Mark paid', callback_data: 'wp:' + id }, { text: '↩️ Reject', callback_data: 'wr:' + id }]]);
  return { id };
}
// player-to-player transfer: both statements test the sender's balance at the same moment, so either both apply or neither does
async function makeTransfer(env, u, to, amt) {
  const db = env.DB, c = C(amt);
  const r = await db.batch([
    db.prepare('UPDATE users SET balance=balance+?1 WHERE id=?3 AND id<>?2 AND (SELECT balance FROM users WHERE id=?2)>=?1').bind(c, u.id, to),
    db.prepare('UPDATE users SET balance=balance-?1 WHERE id=?2 AND (SELECT balance FROM users WHERE id=?2)>=?1 AND EXISTS(SELECT 1 FROM users WHERE id=?3 AND id<>?2)').bind(c, u.id, to)]);
  return r[1].meta.changes > 0 ? { ok: true } : { error: 'insufficient_balance' };
}

/* ---------- settings, bans and admin log (tables are created automatically) ---------- */
let tablesReady = false;
const ensureTables = async env => { if (tablesReady) return; await env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS bans(id INTEGER PRIMARY KEY)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,actor TEXT,action TEXT,detail TEXT)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_state(uid INTEGER PRIMARY KEY,step TEXT,data TEXT,ts INTEGER)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS referrals(user_id INTEGER PRIMARY KEY,ref_id INTEGER,ts INTEGER)')]);
  try { await env.DB.prepare('SELECT auto_off FROM users LIMIT 1').first() } catch (e) { try { await env.DB.prepare('ALTER TABLE users ADD COLUMN auto_off INTEGER DEFAULT 0').run() } catch (e2) { } }
  tablesReady = true };
const cfg = { t: 0, set: {}, bans: new Set() }; // settings and bans are cached for 5 seconds to keep requests fast
const loadCfg = async env => { if (Date.now() - cfg.t < 5000) return cfg; await ensureTables(env); const [a, b] = await env.DB.batch([env.DB.prepare('SELECT k,v FROM settings'), env.DB.prepare('SELECT id FROM bans')]); cfg.set = Object.fromEntries(a.results.map(r => [r.k, r.v])); cfg.bans = new Set(b.results.map(r => String(r.id))); cfg.t = Date.now(); return cfg };
const getSet = async (env, k) => (await loadCfg(env)).set[k] ?? null;
const setSet = async (env, k, v) => { await ensureTables(env); await env.DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run(); cfg.t = 0 };
const isBanned = async (env, id) => (await loadCfg(env)).bans.has(String(id));

/* ---------- shared game rounds (advanced only inside the GameHub Durable Object) ---------- */
const latest = db => db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').first();
const callsAt = (r, now) => Math.min(75, Math.max(0, Math.floor((now - r.start_ts - LOBBY_MS) / CALL_MS) + 1));
// Once a round has started its picks and number order never change, so they are kept in memory
// (one database read per round instead of one per request) and the winner check only looks at newly called numbers.
let rcache = null;
async function roundCache(env, r) {
  if (rcache && rcache.id === r.id) return rcache;
  const picks = (await env.DB.prepare('SELECT p.cartela,p.user_id,u.name FROM picks p JOIN users u ON u.id=p.user_id WHERE p.round_id=?').bind(r.id).all()).results;
  return rcache = { id: r.id, picks, order: numberOrder(r.seed), cards: null, k: 0, marked: new Set(), win: null, manual: new Set(), mt: 0 };
}
function winnersAt(rc, k) { // same result as findWinners(order, picks, k), but remembers how far it already checked
  if (!rc.cards) rc.cards = rc.picks.map(p => makeCard(p.cartela));
  while (!rc.win && rc.k < k) {
    rc.marked.add(rc.order[rc.k]); rc.k++;
    const w = rc.picks.filter((p, i) => !rc.manual.has(p.user_id) && hasBingo(rc.cards[i], rc.marked));
    if (w.length) rc.win = { k: rc.k, picks: w };
  }
  return rc.win;
}
function refundAndClose(env, r, from, now) {
  const db = env.DB;
  return db.batch([
    db.prepare("UPDATE users SET bonus_c=MIN(?5,bonus_c+(SELECT COALESCE(SUM(p.bonus_c),0) FROM picks p WHERE p.round_id=?1 AND p.user_id=users.id)),balance=balance+(SELECT COUNT(*)*?2-COALESCE(SUM(p.bonus_c),0) FROM picks p WHERE p.round_id=?1 AND p.user_id=users.id) WHERE id IN(SELECT user_id FROM picks WHERE round_id=?1) AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status=?4)").bind(r.id, r.stake_c, now, from, bonusC(env)),
    db.prepare("UPDATE rounds SET status='cancelled',ended_ts=?3 WHERE id=?1 AND status=?2").bind(r.id, from, now)]);
}
async function refreshManual(env, r, rc, now) { // players with Automatic switched off (re-read at most every 2 seconds)
  if (now - rc.mt < 2000) return; rc.mt = now;
  rc.manual = new Set((await env.DB.prepare('SELECT DISTINCT p.user_id FROM picks p JOIN users u ON u.id=p.user_id WHERE p.round_id=? AND u.auto_off=1').bind(r.id).all()).results.map(x => x.user_id));
}
async function settle(env, r, picks, w, now) { // pays the winners and ends the round; returns false if another request already did
  const db = env.DB, prize = Math.floor(picks.length * r.stake_c * CUT), share = Math.floor(prize / w.picks.length);
  const res = await db.batch([...w.picks.map(p => db.prepare("UPDATE users SET balance=balance+?3 WHERE id=?2 AND EXISTS(SELECT 1 FROM rounds WHERE id=?1 AND status='running')").bind(r.id, p.user_id, share)),
    db.prepare("UPDATE rounds SET status='ended',ended_ts=?2,called_n=?3,winners=?4 WHERE id=?1 AND status='running'").bind(r.id, now, w.k, JSON.stringify(w.picks.map(p => p.cartela)))]);
  return res[res.length - 1].meta.changes > 0;
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
    const k = callsAt(r, now), rc = await roundCache(env, r), picks = rc.picks;
    await refreshManual(env, r, rc, now);
    const w = winnersAt(rc, k);
    if (w) {
      await settle(env, r, picks, w, now);
    } else if (k >= 75) await refundAndClose(env, r, 'running', now);
    r = await db.prepare('SELECT * FROM rounds WHERE id=?').bind(r.id).first();
  }
  return r;
}

/* ---------- GameHub: ONE Durable Object that holds the live game in memory ----------
   Every player poll is answered from memory. The database is touched only when something really changes:
   a round starts / ends, a number is called, a player picks or drops a cartela, or money moves.
   All the truth is still in D1, so if this object is ever restarted it rebuilds itself from the database. */
export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.round = null; this.picks = []; this.pickRound = 0; this.pv = 0; this.pt = 0; this.nextAt = 0; this.busy = null; this.sh = null;
  }
  async sync() { // returns the current round; asks the database only when the next event is due
    const now = Date.now();
    if (this.round && now < this.nextAt && !(this.round.status === 'lobby' && now - this.pt > 20000)) return this.round;
    if (!this.busy) this.busy = this.refresh().finally(() => { this.busy = null });
    await this.busy; return this.round;
  }
  async refresh() {
    const env = this.env, r = await advance(env), now = Date.now();
    if (r.status === 'lobby') {
      if (this.pickRound !== r.id || now - this.pt > 20000) await this.loadLobby(r);
    } else {
      const rc = await roundCache(env, r);
      if (this.picks !== rc.picks) { this.picks = rc.picks; this.pv++ }
      this.pickRound = r.id;
    }
    const k = r.status === 'running' ? callsAt(r, now) : 0;
    const due = r.status === 'lobby' ? r.start_ts + LOBBY_MS : r.status === 'running' ? r.start_ts + LOBBY_MS + k * CALL_MS : r.ended_ts + REST_MS;
    this.nextAt = Math.max(due, now + (r.status === 'running' ? 250 : 1000));
    this.round = r;
  }
  async loadLobby(r) {
    const v = this.pv;
    const rows = (await this.env.DB.prepare('SELECT p.cartela,p.user_id,u.name FROM picks p JOIN users u ON u.id=p.user_id WHERE p.round_id=?').bind(r.id).all()).results;
    if (this.pickRound !== r.id || v === this.pv) { this.picks = rows; this.pickRound = r.id; this.pv++ } // a pick that arrived while reading wins over the older read
    this.pt = Date.now();
  }
  async current() { return this.sync() } // the current round row, kept fresh
  async state(me) { // same JSON the old stateFor produced; me = { id, auto_off, balance, bonus_c } read fresh by the caller
    const r = await this.sync(), now = Date.now();
    const n = r.status === 'running' ? callsAt(r, now) : r.status === 'ended' ? r.called_n : 0;
    const key = r.id + '|' + r.status + '|' + this.pv + '|' + n;
    let sh = this.sh;
    if (!sh || sh.key !== key) {
      const picks = this.picks, by = new Map();
      for (const p of picks) { let a = by.get(p.user_id); if (!a) by.set(p.user_id, a = []); a.push(p.cartela) }
      const win = r.status === 'ended' ? JSON.parse(r.winners || '[]') : [];
      const called = n ? (await roundCache(this.env, r)).order.slice(0, n) : [];
      sh = this.sh = { key, by, called, taken: picks.map(p => p.cartela), players: by.size, cards: picks.length,
        derash: B(Math.floor(picks.length * r.stake_c * CUT)), winners: picks.filter(p => win.includes(p.cartela)).map(p => ({ cartela: p.cartela, name: p.name })) };
    }
    return { now, round: { id: r.id, status: r.status, start_ts: r.start_ts, lobby_ms: LOBBY_MS, call_ms: CALL_MS, stake: B(r.stake_c), rest_ms: REST_MS, ended_ts: r.ended_ts },
      taken: sh.taken, mine: sh.by.get(me.id) || [], called: sh.called, players: sh.players, cards: sh.cards,
      auto: !me.auto_off, derash: sh.derash, winners: sh.winners, balance: B(me.balance), bonus: B(me.bonus_c) };
  }
  async picked(op, roundId, no, uid, name, me) { // the database already accepted this pick / unpick: update memory and answer
    if (this.round && this.round.id === roundId && this.round.status === 'lobby' && this.pickRound === roundId) {
      if (op === 'pick') { if (!this.picks.some(p => p.cartela === no)) this.picks.push({ cartela: no, user_id: uid, name }) }
      else this.picks = this.picks.filter(p => !(p.cartela === no && p.user_id === uid));
      this.pv++;
    }
    return this.state(me);
  }
  async bingo(me) { // manual BINGO button: wins only if one of your cartelas really is complete right now
    const r = await this.sync(), now = Date.now();
    if (r.status === 'ended' || r.status === 'cancelled') return { error: 'round_over' };
    if (r.status !== 'running') return { error: 'no_bingo' };
    const rc = await roundCache(this.env, r), k = callsAt(r, now), marked = new Set(rc.order.slice(0, k));
    const mine = rc.picks.filter(x => x.user_id === me.id && hasBingo(makeCard(x.cartela), marked));
    if (!mine.length) return { error: 'no_bingo' };
    if (!(await settle(this.env, r, rc.picks, { k, picks: mine }, now))) return { error: 'round_over' };
    this.nextAt = 0;
    const f = await this.env.DB.prepare('SELECT balance,bonus_c,auto_off FROM users WHERE id=?').bind(me.id).first();
    return { state: await this.state({ id: me.id, auto_off: f.auto_off, balance: f.balance, bonus_c: f.bonus_c }) };
  }
  async manualChanged() { if (rcache) rcache.mt = 0; this.nextAt = 0 } // a player switched Automatic on/off
  async invalidate() { this.nextAt = 0; cfg.t = 0 } // admin changed something: re-read on the next request
}
const hubOf = env => env.HUB.get(env.HUB.idFromName('main'));
const noHub = () => J({ error: 'server_error', detail: 'HUB binding is missing in wrangler.json' }, 500);
const poke = env => env.HUB ? hubOf(env).invalidate().catch(() => { }) : null;

const startOfDay = () => Math.floor((Date.now() + 3 * 36e5) / 864e5) * 864e5 - 3 * 36e5; // Ethiopia time (UTC+3)
async function leaderboard(env, u, period) {
  const db = env.DB, since = period === 'weekly' ? Date.now() - 7 * 864e5 : startOfDay();
  const base = "FROM picks p JOIN rounds r ON r.id=p.round_id WHERE r.status='ended' AND r.ended_ts>=?1";
  const top = (await db.prepare(`SELECT u.name n,COUNT(DISTINCT p.round_id) g ${base.replace('WHERE', 'JOIN users u ON u.id=p.user_id WHERE')} GROUP BY u.id ORDER BY g DESC LIMIT 10`).bind(since).all()).results;
  const mine = (await db.prepare(`SELECT COUNT(DISTINCT p.round_id) g ${base} AND p.user_id=?2`).bind(since, u.id).first()).g || 0;
  const higher = (await db.prepare(`SELECT COUNT(*) c FROM(SELECT p.user_id,COUNT(DISTINCT p.round_id) g ${base} GROUP BY p.user_id HAVING g>?2)`).bind(since, mine).first()).c;
  return { top: top.map(t => [t.n, t.g]), me: { rank: mine ? higher + 1 : null, played: mine } };
}

/* ---------- Telegram bot: menu buttons, deposit / withdraw / transfer flows, admin commands ---------- */
async function menuAction(env, u, act) { // a menu button was pressed
  const uid = u.id, db = env.DB;
  if (act === 'bal') { const f = await db.prepare('SELECT balance,bonus_c FROM users WHERE id=?').bind(uid).first(); return sendMenu(env, uid, `💳 ቀሪ ሂሳብዎ: ${B(f.balance)} ብር` + (f.bonus_c > 0 ? `\n🎁 ቦነስ: ${B(f.bonus_c)} ብር` : '')) }
  if (act === 'dep') { await setState(env, uid, 'dep_amount', {}); return sendTo(env, uid, `ማስገባት የፈለጉትን የብር መጠን ከ ${MIN_DEP} ብር ጀምሮ ያስገቡ።`) }
  if (act === 'ins') return sendMenu(env, uid, instructionText);
  if (act === 'wd') {
    if (!(await hasDeposit(env, uid))) return sendMenu(env, uid, '⚠️ ገንዘብ ለማውጣት ቢያንስ አንድ ጊዜ ገንዘብ ማስገባት ያስፈልጋል።');
    await setState(env, uid, 'wd_amount', {}); return sendTo(env, uid, `💸 ማውጣት የፈለጉትን የብር መጠን ከ ${MIN_WD} ብር ጀምሮ ያስገቡ።\n💳 ቀሪ ሂሳብዎ: ${B(u.balance)} ብር`);
  }
  if (act === 'tr') {
    if (!(await hasDeposit(env, uid))) return sendMenu(env, uid, '⚠️ ገንዘብ ለማስተላለፍ ቢያንስ አንድ ጊዜ ገንዘብ ማስገባት ያስፈልጋል።');
    await setState(env, uid, 'tr_phone', {}); return sendTo(env, uid, '🎁 ገንዘብ የሚልኩለትን ተጫዋች ስልክ ቁጥር ያስገቡ (ለምሳሌ 09xxxxxxxx)።');
  }
  if (act === 'inv') {
    const c = (await db.prepare('SELECT COUNT(*) c FROM referrals r JOIN users x ON x.id=r.user_id WHERE r.ref_id=? AND x.phone IS NOT NULL').bind(uid).first()).c;
    return sendMenu(env, uid, `🔗 ጓደኞችዎን ይጋብዙ!\n\nየእርስዎ መጋበዣ ሊንክ፦\nhttps://t.me/${env.BOT_USERNAME || 'Amanbingo2bot'}?start=ref${uid}\n\n👥 የተመዘገቡ ጓደኞችዎ፦ ${c}`);
  }
}
async function onPlayerCb(env, q, parts) { // menu / bank / cancel buttons
  const uid = q.from.id, a = parts[0];
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
  if (!u || !u.phone) return askContact(env, uid);
  if (await isBanned(env, uid)) return sendTo(env, uid, `⛔ አካውንትዎ ታግዷል። ለእርዳታ ${SUPPORT} ያነጋግሩ።`);
  if (a === 'm') { await clearState(env, uid); return menuAction(env, u, parts[1]) }
  if (a === 'b') {
    if (parts[1] === 'x') { await clearState(env, uid); return sendMenu(env, uid, '❌ ተሰርዟል።') }
    const flow = parts[1], bank = parts[2], st = await getState(env, uid);
    if (!BANKS[bank] || (bank === 'cbe' && !env.CBE_ACCOUNT)) return;
    if (flow === 'd') {
      if (!st || st.step !== 'dep_bank') return sendMenu(env, uid, '⌛ ጊዜው አልፏል። እባክዎ «Deposit» ን እንደገና ይጫኑ።');
      await setState(env, uid, 'dep_paste', { amt: st.amt, method: bank });
      return sendTo(env, uid, `የሚያጋጥማቹ የክፍያ ችግር:\n${SUPPORT} ላይ ፃፉልን።\n\n1. ከታች ባለው አካውንት ${st.amt} ብር ያስገቡ\n${acctText(env, bank)}\n\n2. የከፈሉበትን አጭር የጽሁፍ መልዕክት(message) copy በማድረግ እዚ ላይ Paste አድርገው ያስገቡና ይላኩት 👇👇👇\n\n⚠️ መልዕክቱን ሙሉ በሙሉ ያለምንም ለውጥ ይላኩ (የግብይት ቁጥሩን ጨምሮ)።`);
    }
    if (flow === 'w') {
      if (!st || st.step !== 'wd_bank') return sendMenu(env, uid, '⌛ ጊዜው አልፏል። እባክዎ «Withdraw» ን እንደገና ይጫኑ።');
      await setState(env, uid, 'wd_account', { amt: st.amt, method: bank });
      return sendTo(env, uid, `${BANKS[bank]} — ገንዘቡ የሚላክበትን አካውንት ወይም ስልክ ቁጥር ያስገቡ።`);
    }
  }
}
async function onStep(env, u, st, text) { // the player typed something while in a flow
  const uid = u.id, t = String(text).trim(), num = Number(t.replace(/,/g, '')), isAmt = t !== '' && isFinite(num) && num > 0 && num <= 100000;
  if (st.step === 'dep_amount') {
    if (!isAmt || num < MIN_DEP) return sendTo(env, uid, `⚠️ ማስገባት የሚችሉት ከ ${MIN_DEP} ብር ጀምሮ ነው። ቁጥር ብቻ ያስገቡ።`);
    await setState(env, uid, 'dep_bank', { amt: num });
    return sendTo(env, uid, '🏦 የሚፈልጉትን የክፍያ አማራጭ ይምረጡ፦\n- ከቴሌ ብር ወደ ቴሌ ብር\n- ከባንክ ወደ ተመሳሳይ ባንክ ብቻ ያስገቡ', bankKb(env, 'd'));
  }
  if (st.step === 'dep_bank') return sendTo(env, uid, '👇 እባክዎ ከታች ካሉት አማራጮች ይምረጡ።', bankKb(env, 'd'));
  if (st.step === 'dep_paste') {
    const pr = parsePaste(t);
    if (!pr) return sendTo(env, uid, '⚠️ የግብይት ቁጥር አልተገኘም። የከፈሉበትን ሙሉ መልዕክት እንደገና copy አድርገው Paste ያድርጉ።');
    const amt = pr.amount_c ? B(pr.amount_c) : st.amt; // the amount written in the bank SMS is the real money, so it wins over the typed amount
    if (amt < MIN_DEP) return sendTo(env, uid, `⚠️ ማስገባት የሚችሉት ከ ${MIN_DEP} ብር ጀምሮ ነው። በመልዕክቱ ላይ ያለው መጠን ${amt} ብር ነው።`);
    const r = await makeDeposit(env, u, amt, pr.txid, pr.bank || st.method);
    if (r.error) return sendTo(env, uid, '⚠️ ይህ የግብይት ቁጥር ከዚህ በፊት ተመዝግቧል። ሌላ መልዕክት ያስገቡ።');
    await clearState(env, uid);
    return r.status === 'approved' ? null : sendMenu(env, uid, `⏳ የ${amt} ብር ጥያቄዎ ደርሶናል። መልዕክቱ ሲረጋገጥ ገንዘቡ በራስ-ሰር ወደ ሂሳብዎ ይጨመራል (አስተዳዳሪውም ያረጋግጣል)።`);
  }
  if (st.step === 'wd_amount') {
    if (!isAmt || num < MIN_WD) return sendTo(env, uid, `⚠️ ማውጣት የሚችሉት ከ ${MIN_WD} ብር ጀምሮ ነው። ቁጥር ብቻ ያስገቡ።`);
    if (C(num) > u.balance) return sendTo(env, uid, `⚠️ ቀሪ ሂሳብዎ በቂ አይደለም (${B(u.balance)} ብር)። ሌላ መጠን ያስገቡ።`);
    await setState(env, uid, 'wd_bank', { amt: num });
    return sendTo(env, uid, '🏦 ገንዘቡ የሚላክበትን አማራጭ ይምረጡ፦', bankKb(env, 'w'));
  }
  if (st.step === 'wd_bank') return sendTo(env, uid, '👇 እባክዎ ከታች ካሉት አማራጮች ይምረጡ።', bankKb(env, 'w'));
  if (st.step === 'wd_account') {
    const account = t.slice(0, 40); if (account.length < 4) return sendTo(env, uid, '⚠️ አካውንት ወይም ስልክ ቁጥር በትክክል ያስገቡ።');
    const r = await makeWithdrawal(env, u, st.amt, account, st.method);
    if (r.error === 'deposit_required') { await clearState(env, uid); return sendMenu(env, uid, '⚠️ ገንዘብ ለማውጣት ቢያንስ አንድ ጊዜ ገንዘብ ማስገባት ያስፈልጋል።') }
    if (r.error) { await clearState(env, uid); return sendMenu(env, uid, '⚠️ ቀሪ ሂሳብዎ በቂ አይደለም።') }
    await clearState(env, uid);
    return sendMenu(env, uid, `✅ የ${st.amt} ብር የማውጣት ጥያቄዎ ተልኳል። አስተዳዳሪው ሲልክልዎ መልዕክት ይደርስዎታል።`);
  }
  if (st.step === 'tr_phone') {
    const ph = normPhone(t); if (!ph) return sendTo(env, uid, '⚠️ ስልክ ቁጥሩ ትክክል አይደለም። (09… ወይም 07…) ያስገቡ።');
    const to = await env.DB.prepare('SELECT id,name FROM users WHERE phone=?').bind(ph).first();
    if (!to) return sendTo(env, uid, '⚠️ በዚህ ስልክ ቁጥር የተመዘገበ ተጫዋች አልተገኘም።');
    if (to.id === uid) return sendTo(env, uid, '⚠️ ለራስዎ ማስተላለፍ አይችሉም።');
    await setState(env, uid, 'tr_amount', { to: to.id, name: to.name });
    return sendTo(env, uid, `🎁 ለ ${to.name} የሚልኩትን የብር መጠን ያስገቡ (ከ ${MIN_TR} ብር ጀምሮ)።\n💳 ቀሪ ሂሳብዎ: ${B(u.balance)} ብር`);
  }
  if (st.step === 'tr_amount') {
    if (!isAmt || num < MIN_TR) return sendTo(env, uid, `⚠️ ማስተላለፍ የሚችሉት ከ ${MIN_TR} ብር ጀምሮ ነው። ቁጥር ብቻ ያስገቡ።`);
    const r = await makeTransfer(env, u, st.to, num);
    await clearState(env, uid);
    if (r.error) return sendMenu(env, uid, '⚠️ ቀሪ ሂሳብዎ በቂ አይደለም።');
    say(env, st.to, `🎁 ${num} ብር ከ ${u.name} ተላልፎልዎታል።`, playKb(env));
    return sendMenu(env, uid, `✅ ${num} ብር ለ ${st.name} ተልኳል።`);
  }
  return null;
}

async function onTelegram(env, up) {
  const db = env.DB; await ensureTables(env);
  if (up.callback_query) {
    const q = up.callback_query, parts = String(q.data).split(':'), [a, id] = parts;
    if (a === 'm' || a === 'b') return onPlayerCb(env, q, parts);
    if (!(await isAdmin(env, q.from.id))) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Admin only' });
    const ok = a === 'da' ? await decideDeposit(env, +id, true) : a === 'dr' ? await decideDeposit(env, +id, false) : a === 'wp' ? await decideWithdraw(env, +id, true) : a === 'wr' ? await decideWithdraw(env, +id, false) : false;
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: ok ? 'Done' : 'Already processed' });
    return tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: q.message.text + (ok ? '\n\n✔ Done' : '\n\n(already processed)') });
  }
  const m = up.message; if (!m) return;
  if (m.contact) return onContact(env, m); // player shared their phone number
  if (!m.text) return;
  const text = m.text.trim(), cmd = text.split(/[\s@]/)[0].toLowerCase(), uid = m.from.id; await refreshBonus(env, uid, Date.now()); const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
  if (text.startsWith('/') || Object.values(BTN).includes(text) || text === 'Admin 🛠') await clearState(env, uid); // a command or menu text always leaves any flow
  if (cmd === '/start' && !(u && u.phone)) { // remember who invited this player
    const mm = text.match(/^\/start(?:@\w+)?\s+ref(\d+)/i);
    if (mm && Number(mm[1]) !== uid) await db.prepare('INSERT OR IGNORE INTO referrals(user_id,ref_id,ts) VALUES(?,?,?)').bind(uid, Number(mm[1]), Date.now()).run();
  }
  if (cmd === '/balance' || text === BTN.bal) {
    if (!u || !u.phone) return askContact(env, uid);
    return menuAction(env, u, 'bal');
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
  if ((cmd === '/admin' || text === 'Admin 🛠') && await isAdmin(env, uid)) return tg(env, 'sendMessage', { chat_id: uid, text: 'Admin dashboard', reply_markup: { inline_keyboard: [[{ text: 'Open admin 🛠', web_app: { url: adminUrl(env) } }]] } });
  if (isOwner(env, uid) && (cmd === '/broadcast' || cmd === '/more')) {
    const rd = async k => ((await db.prepare('SELECT v FROM settings WHERE k=?').bind(k).first()) || {}).v || '';
    if (cmd === '/broadcast') {
      const t0 = m.text.replace(/^\/broadcast(@\w+)?\s*/i, '');
      if (!t0) return say(env, uid, 'Send it like this: /broadcast your message');
      await setSet(env, 'bc_text', t0); await setSet(env, 'bc_cursor', '0');
    }
    const t = await rd('bc_text'), cur = Number(await rd('bc_cursor') || 0);
    if (!t) return say(env, uid, 'Start with /broadcast your message');
    const rows = (await db.prepare("SELECT id FROM users WHERE phone IS NOT NULL AND id>? ORDER BY id LIMIT 40").bind(cur).all()).results;
    if (!rows.length) return say(env, uid, '✅ Broadcast finished.');
    await Promise.all(rows.map(r => env.PROMO_PHOTO
      ? tg(env, 'sendPhoto', { chat_id: r.id, photo: env.PROMO_PHOTO, caption: t, reply_markup: { inline_keyboard: playKb(env) } })
      : tg(env, 'sendMessage', { chat_id: r.id, text: t, reply_markup: { inline_keyboard: playKb(env) } })));
    await setSet(env, 'bc_cursor', String(rows[rows.length - 1].id));
    return say(env, uid, `📤 Sent to ${rows.length} players. Send /more for the next batch.`);
  }
  if (!u || !u.phone) return askContact(env, uid); // new player: must share the phone number first
  if (await isBanned(env, uid)) return sendTo(env, uid, `⛔ አካውንትዎ ታግዷል። ለእርዳታ ${SUPPORT} ያነጋግሩ።`);
  const st = await getState(env, uid); if (st) { const h = await onStep(env, u, st, text); if (h !== null && h !== undefined) return h; if (st.step === 'dep_paste') return } // inside a flow: the step handles the message
  if (text === BTN.play || cmd === '/play') return sendTo(env, uid, '🎮 ለመጫወት ከታች ያለውን ቁልፍ ይጫኑ።', { inline_keyboard: playKb(env) });
  if (text === BTN.dep || cmd === '/deposit') return menuAction(env, u, 'dep');
  if (text === BTN.sup || cmd === '/support') return sendTo(env, uid, `🆘 ለእርዳታ ያነጋግሩን: ${SUPPORT}`, { inline_keyboard: [[{ text: 'Contact Support... 🆘', url: 'https://t.me/' + SUPPORT.slice(1) }]] });
  if (cmd === '/withdraw') return menuAction(env, u, 'wd');
  if (cmd === '/transfer') return menuAction(env, u, 'tr');
  if (cmd === '/invite') return menuAction(env, u, 'inv');
  if (cmd === '/instruction') return menuAction(env, u, 'ins');
  return sendMenu(env, uid, '🎮 እንኳን ደህና መጡ! ከታች ካሉት አማራጮች ይምረጡ።');
}
const depositText = x => `💰 Deposit #${x.id}\n${x.name} · ${x.phone}\nAmount: ${B(x.amount_c)} birr via ${x.method}\nTransaction: ${x.txid}\nNo matching SMS yet — it is credited automatically when the SMS arrives; approve by hand only if the money really arrived.`;
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
    await setSet(env, 'stake', String(st)); await log('set stake', st + ' birr (from the next round)'); await poke(env);
    return J({ ok: true, stake: st });
  }
  if (name === 'pause') {
    await setSet(env, 'paused', b.paused ? '1' : '0'); await log(b.paused ? 'pause game' : 'resume game', ''); await poke(env);
    return J({ ok: true, paused: !!b.paused });
  }
  if (name === 'log') {
    const r = (await db.prepare('SELECT ts,actor,action,detail FROM admin_log ORDER BY id DESC LIMIT 30').all()).results;
    return J({ items: r });
  }
  if (name === 'game' || name === 'game-start' || name === 'game-stop') {
    if (!env.HUB) return noHub();
    const hub = hubOf(env); let r = await hub.current();
    if (name === 'game-stop' && (r.status === 'lobby' || r.status === 'running')) {
      await refundAndClose(env, r, r.status, Date.now()); // cancels the round and returns every stake
      await log('cancel round', 'round ' + r.id); await hub.invalidate(); r = await hub.current();
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
  if (p === '/sms' && req.method === 'POST') { // the phone(s) that receive the money forward every incoming bank SMS here (Telebirr, Dashen, BOA, CBE)
    if (req.headers.get('x-secret') !== env.SMS_SECRET) return J({ error: 'forbidden' }, 403);
    const raw = await req.text(); let text = raw; try { const o = JSON.parse(raw); text = o.text || o.message || o.body || o.content || raw } catch (e) { }
    const s = parseSms(text); if (!s) return J({ ok: true, parsed: false });
    await db.prepare('INSERT OR IGNORE INTO sms_log(txid,amount_c,raw,ts) VALUES(?,?,?,?)').bind(s.txid, s.amount_c, String(text).slice(0, 500), now).run();
    await tryMatch(env, s.txid); return J({ ok: true, parsed: true, bank: s.bank });
  }
  if (p === '/tg/' + env.TG_SECRET && req.method === 'POST') { await onTelegram(env, await req.json()); return J({ ok: true }) }
  if (!p.startsWith('/api/')) return J({ error: 'not_found' }, 404);
  if (p.startsWith('/api/admin/')) return adminRoute(req, env, url);
  const tu = await verifyInit(req.headers.get('x-init-data'), env.BOT_TOKEN); if (!tu) return J({ error: 'unauthorized' }, 401);
  // Look the player up with a plain read first. A write happens only for a brand-new player or when the bonus period changes.
  const selUser = () => db.prepare('SELECT * FROM users WHERE id=?').bind(tu.id);
  let u = await selUser().first();
  if (!u) u = (await db.batch([db.prepare('INSERT INTO users(id,name,created_ts) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(tu.id, tu.first_name || 'player', now), refreshBonusStmt(env, tu.id, now), selUser()]))[2].results[0];
  else if (u.bonus_period < bonusPeriod(now) || (bonusC(env) === 0 && u.bonus_c !== 0)) { await refreshBonusStmt(env, u.id, now).run(); u = await selUser().first() }
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const need = () => u.phone ? null : J({ error: 'not_registered' }, 403);
  if (p !== '/api/me' && await isBanned(env, u.id)) return J({ error: 'banned' }, 403);
  if (p === '/api/me') { const dep = (await db.prepare('SELECT amount_c,status,ts FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results, wd = (await db.prepare('SELECT amount_c,status,ts FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(u.id).all()).results; return J({ id: u.id, name: u.name, phone: u.phone, registered: !!u.phone, balance: B(u.balance), bonus: B(u.bonus_c), deposits: dep.map(x => ({ ...x, amount: B(x.amount_c) })), withdrawals: wd.map(x => ({ ...x, amount: B(x.amount_c) })) }) }
  if (p === '/api/register') { if (u.phone) return J({ error: 'already_registered' }, 409); const ph = normPhone(b.phone), nm = String(b.name || '').trim().slice(0, 30); if (!ph || nm.length < 2) return J({ error: 'bad_input' }, 400);
    try { const rr = await db.prepare("UPDATE users SET name=?1,phone=?2,balance=balance+?3 WHERE id=?4 AND (phone IS NULL OR phone='')").bind(nm, ph, welcomeC(env), u.id).run(); if (!rr.meta.changes) return J({ error: 'already_registered' }, 409) } catch (e) { return J({ error: 'phone_used' }, 409) }
    if (welcomeC(env) > 0) await say(env, u.id, `🎉 እንኳን ደስ አለዎት! በተሳካ ሁኔታ ተመዝግበዋል። ${B(welcomeC(env))} ብር ወደ ዋሌትዎ ተጨምሯል።`, playKb(env));
    return J({ ok: true }) }
  if (p === '/api/state') { // the hot path: answered from the GameHub's memory, no database work beyond the player lookup above
    if (!env.HUB) return noHub();
    return J(await hubOf(env).state({ id: u.id, auto_off: u.auto_off, balance: u.balance, bonus_c: u.bonus_c }));
  }
  if (p === '/api/leaderboard') return J(await leaderboard(env, u, url.searchParams.get('period')));
  const bad = need(); if (bad) return bad;
  if (p === '/api/auto') { // Automatic on/off for this player
    await db.prepare('UPDATE users SET auto_off=?1 WHERE id=?2').bind(b.auto ? 0 : 1, u.id).run();
    if (env.HUB) await hubOf(env).manualChanged().catch(() => { });
    return J({ ok: true, auto: !!b.auto });
  }
  if (p === '/api/bingo') { // manual BINGO button
    if (!env.HUB) return noHub();
    const r = await hubOf(env).bingo({ id: u.id });
    if (r.error) return J({ error: r.error }, 409);
    return J(r.state);
  }
  if (p === '/api/pick' || p === '/api/unpick') {
    if (!env.HUB) return noHub();
    const no = Math.floor(Number(b.cartela)); if (!(no >= 1 && no <= TOTAL)) return J({ error: 'bad_input' }, 400);
    const hub = hubOf(env), r = await hub.current();
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
    const me = await db.prepare('SELECT id,auto_off,balance,bonus_c FROM users WHERE id=?').bind(u.id).first(); // fresh balance after the stake moved
    return J(await hub.picked(p === '/api/pick' ? 'pick' : 'unpick', r.id, no, u.id, u.name, me));
  }
  if (p === '/api/deposit') {
    const amt = Number(b.amount), txid = String(b.txid || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), method = ['telebirr', 'cbe', 'boa', 'dashen'].includes(b.method) ? b.method : 'telebirr';
    if (!(amt >= MIN_DEP) || txid.length < 8 || txid.length > 24) return J({ error: 'bad_input', min: MIN_DEP }, 400);
    const r = await makeDeposit(env, u, amt, txid, method); if (r.error) return J({ error: r.error }, 409);
    return J({ status: r.status, balance: B((await db.prepare('SELECT balance FROM users WHERE id=?').bind(u.id).first()).balance) });
  }
  if (p === '/api/withdraw') {
    const amt = Number(b.amount), account = String(b.account || '').trim().slice(0, 40), method = String(b.method || 'telebirr').slice(0, 20);
    if (!(amt >= MIN_WD) || !account) return J({ error: 'bad_input', min: MIN_WD }, 400);
    const r = await makeWithdrawal(env, u, amt, account, method); if (r.error) return J({ error: r.error }, r.error === 'deposit_required' ? 403 : 409);
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
