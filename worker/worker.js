// INDICATOR Mini App — сервер (Cloudflare Worker, один файл, без зависимостей).
//
// Нужно в настройках Worker (Settings → Variables and Secrets):
//   BOT_TOKEN      секрет: токен бота из @BotFather
//   CRYPTO_TOKEN   секрет: токен приложения из @CryptoBot → Crypto Pay → My Apps
//   ADMIN_ID       ваш числовой Telegram id (бот покажет его по команде /id)
//   SETUP_KEY      любой длинный пароль, нужен один раз для /setup
//   WEBAPP_URL     https://pikulaalukip.github.io/indicator-miniapp/
// Привязка KV (Settings → Bindings → KV namespace): имя переменной DB.
// Cron (Settings → Triggers → Cron): 0 9 * * *  (раз в день, напоминания и окончания).

const PLANS = {
  m1: { name: "1 месяц", price: 99, days: 30 },
  m3: { name: "3 месяца", price: 211, days: 90 },
  life: { name: "Навсегда", price: 499, days: 0 }
};
const ASSETS = ["USDT", "TON", "BTC"];
const DAY = 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname.startsWith("/api/")) return cors(await api(url.pathname.slice(5), req, env));
      if (url.pathname === "/crypto" && req.method === "POST") return await cryptoHook(req, env);
      if (url.pathname === "/tg/" + (await tgPath(env)) && req.method === "POST") { await tgHook(await req.json(), env); return new Response("ok"); }
      if (url.pathname === "/setup") return await setup(url, env);
      return new Response("INDICATOR server работает", { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (e) {
      console.log("error", e && e.stack || e);
      return cors(json({ error: e.message || "error" }, e.status || 500));
    }
  },
  async scheduled(_, env) { await daily(env); }
};

// ---------- API для приложения ----------
async function api(path, req, env) {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const u = await checkInitData(body.initData || "", env.BOT_TOKEN);
  if (!u) return json({ error: "Откройте приложение внутри Telegram" }, 401);
  const user = (await getUser(env, u.id)) || { uid: u.id };
  user.username = u.username || ""; user.name = [u.first_name, u.last_name].filter(Boolean).join(" ");

  if (path === "me") return json(publicUser(user));

  if (path === "invoice") {
    const plan = PLANS[body.plan]; if (!plan) return json({ error: "Неизвестный тариф" }, 400);
    const asset = ASSETS.includes(body.asset) ? body.asset : "USDT";
    const inv = await crypto_(env, "createInvoice", {
      currency_type: "fiat", fiat: "USD", amount: String(plan.price), accepted_assets: ASSETS.join(","),
      description: `INDICATOR · доступ «${plan.name}»`, payload: JSON.stringify({ uid: u.id, plan: body.plan }),
      expires_in: 3600, allow_comments: false, allow_anonymous: false
    });
    await env.DB.put("inv:" + inv.invoice_id, JSON.stringify({ uid: u.id, plan: body.plan, status: "active" }), { expirationTtl: 30 * 86400 });
    await putUser(env, user);
    return json({ invoice_id: inv.invoice_id, url: inv.mini_app_invoice_url || inv.bot_invoice_url, asset });
  }

  if (path === "status") {
    const rec = JSON.parse((await env.DB.get("inv:" + body.invoice_id)) || "null");
    if (!rec || rec.uid !== u.id) return json({ error: "Счёт не найден" }, 404);
    if (rec.status !== "paid") { // на случай, если вебхук задержался
      const r = await crypto_(env, "getInvoices", { invoice_ids: String(body.invoice_id) });
      const it = r.items && r.items[0];
      if (it && it.status === "paid") await markPaid(env, it);
    }
    const fresh = JSON.parse(await env.DB.get("inv:" + body.invoice_id));
    return json({ status: fresh.status, user: publicUser((await getUser(env, u.id)) || user) });
  }

  if (path === "tv") {
    const nick = String(body.nick || "").trim().replace(/^@/, "").slice(0, 60);
    if (!/^[\w.\-]{2,60}$/.test(nick)) return json({ error: "Проверьте ник: только латиница, цифры, _ . -" }, 400);
    const cur = await getUser(env, u.id);
    if (!cur || !cur.plan) return json({ error: "Сначала оплатите доступ" }, 403);
    const old = cur.tv; cur.tv = nick; cur.username = user.username; cur.name = user.name;
    if (cur.status === "paid") cur.status = "pending";
    await putUser(env, cur);
    const changed = old && old !== nick && cur.status === "active";
    await adminTask(env, cur, changed ? `🔁 Смена ника. Был: <code>${esc(old)}</code>. Уберите старый и добавьте новый.` : "🎯 Выдать доступ к индикатору");
    return json(publicUser(cur));
  }

  if (path === "subs") return json(await subs(env, u.id));

  if (path === "free") { // одна бесплатная проверка в неделю, только для подписчиков
    const week = weekId();
    if (isActive(user)) return json({ ok: true });
    if (user.freeWeek === week) return json({ ok: false, error: "Бесплатная проверка на этой неделе уже использована" });
    const s = await subs(env, u.id);
    if (s.channel === false || s.chat === false) return json({ ok: false, error: "Нужна подписка на канал и чат" });
    user.freeWeek = week; await putUser(env, user);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

async function subs(env, uid) {
    const chats = JSON.parse((await env.DB.get("cfg:chats")) || "{}");
    const res = {};
    for (const k of ["channel", "chat"]) {
      if (!chats[k]) { res[k] = null; continue; }
      const m = await tg(env, "getChatMember", { chat_id: chats[k], user_id: uid }).catch(() => null);
      res[k] = !!m && (["creator", "administrator", "member"].includes(m.status) || (m.status === "restricted" && !!m.is_member));
    }
    return res;
}

// ---------- CryptoBot ----------
async function cryptoHook(req, env) {
  const raw = await req.text();
  const key = await crypto.subtle.digest("SHA-256", enc(env.CRYPTO_TOKEN));
  const sig = hex(await hmac(key, raw));
  if (sig !== req.headers.get("crypto-pay-api-signature")) return new Response("bad signature", { status: 401 });
  const upd = JSON.parse(raw);
  if (upd.update_type === "invoice_paid") await markPaid(env, upd.payload);
  return new Response("ok");
}

async function markPaid(env, inv) {
  const rec = JSON.parse((await env.DB.get("inv:" + inv.invoice_id)) || "null") || (() => { try { const p = JSON.parse(inv.payload); return { uid: p.uid, plan: p.plan }; } catch (e) { return null; } })();
  if (!rec || rec.status === "paid") return;
  rec.status = "paid";
  await env.DB.put("inv:" + inv.invoice_id, JSON.stringify(rec), { expirationTtl: 90 * 86400 });
  const plan = PLANS[rec.plan];
  const user = (await getUser(env, rec.uid)) || { uid: rec.uid };
  const base = isActive(user) && user.until ? Math.max(user.until, Date.now()) : Date.now();
  const renewal = isActive(user);
  user.plan = rec.plan; user.until = plan.days ? base + plan.days * DAY : 0; user.paidAt = Date.now();
  user.amount = `${inv.paid_amount || inv.amount} ${inv.paid_asset || inv.asset || ""}`.trim();
  user.reminded = false;
  if (!renewal) user.status = user.tv ? "pending" : "paid";
  await putUser(env, user);
  await tg(env, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "HTML", text:
    `💰 <b>${renewal ? "Продление" : "Новая оплата"}</b>\n${who(user)}\nТариф: ${plan.name} · $${plan.price}\nОплачено: ${esc(user.amount)} (CryptoBot, счёт ${inv.invoice_id})\nДоступ до: ${till(user)}` +
    (renewal ? `\nНик TradingView: <code>${esc(user.tv || "—")}</code>\n\nВ TradingView продлите срок доступа до ${till(user)}.` : user.tv ? "" : "\n\nЖдём ник TradingView, пришлю отдельным сообщением.") });
  if (!renewal && user.tv) await adminTask(env, user, "🎯 Выдать доступ к индикатору");
  await tg(env, "sendMessage", { chat_id: user.uid, text: renewal ? `Оплата получена, доступ продлён до ${till(user)}. Спасибо!` : "Оплата получена ✅ Укажите ник TradingView в приложении, и мы откроем доступ к индикатору." }).catch(() => {});
}

// ---------- Telegram ----------
async function tgHook(upd, env) {
  if (upd.my_chat_member) { // бота сделали админом канала или чата: запоминаем id
    const c = upd.my_chat_member.chat, st = upd.my_chat_member.new_chat_member.status;
    if (st === "administrator") {
      const chats = JSON.parse((await env.DB.get("cfg:chats")) || "{}");
      chats[c.type === "channel" ? "channel" : "chat"] = c.id;
      await env.DB.put("cfg:chats", JSON.stringify(chats));
      await tg(env, "sendMessage", { chat_id: env.ADMIN_ID, text: `✅ Бот подключён как админ: «${c.title}» (${c.type === "channel" ? "канал" : "чат"}). Проверка подписки работает.` }).catch(() => {});
    }
    return;
  }
  if (upd.callback_query) {
    const q = upd.callback_query, [act, uid] = String(q.data || "").split(":");
    if (String(q.from.id) !== String(env.ADMIN_ID)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Только для админа" });
    const user = await getUser(env, uid);
    if (!user) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Пользователь не найден" });
    if (act === "grant") {
      user.status = "active"; await putUser(env, user);
      await tg(env, "sendMessage", { chat_id: user.uid, text: `Доступ открыт 🎉\n\nTradingView → Индикаторы → «Только по приглашению» → INDICATOR.\nНик: ${user.tv}\nДоступ до: ${till(user)}` }).catch(() => {});
      await tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: "HTML", text: q.message.text + "\n\n✅ Выдано" });
    }
    if (act === "removed") {
      user.status = "expired"; user.removed = true; await putUser(env, user);
      await tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: q.message.text + "\n\n✅ Убрано" });
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Готово" });
  }
  const m = upd.message; if (!m || !m.text) return;
  if (m.text.startsWith("/id")) return tg(env, "sendMessage", { chat_id: m.chat.id, text: `Ваш Telegram id: ${m.from.id}` });
  if (m.text.startsWith("/start")) return tg(env, "sendMessage", { chat_id: m.chat.id, text: "INDICATOR: живой график BTC с сигналами, демо и бесплатная проверка монеты раз в неделю.", reply_markup: { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: env.WEBAPP_URL } }]] } });
}

async function adminTask(env, user, title) {
  await tg(env, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "HTML", text:
    `${title}\n${who(user)}\nНик TradingView: <code>${esc(user.tv)}</code>\nТариф: ${PLANS[user.plan].name}\nДоступ до: ${till(user)}\n\nTradingView → ваш скрипт → Manage access → Add user → срок до ${till(user)}.`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Выдал доступ", callback_data: "grant:" + user.uid }]] } });
}

// раз в день: напоминание за 3 дня и окончание доступа
async function daily(env) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "user:", cursor });
    for (const k of page.keys) {
      const user = JSON.parse(await env.DB.get(k.name)); if (!user || !user.until || !user.plan || user.removed) continue;
      const left = user.until - Date.now();
      if (left <= 0 && user.status !== "expired") {
        user.status = "expired"; await putUser(env, user);
        await tg(env, "sendMessage", { chat_id: user.uid, text: "Срок доступа к индикатору закончился. Продлить можно в приложении, вкладка «Доступ»." }).catch(() => {});
        await tg(env, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "HTML", text: `⛔ <b>Доступ закончился</b>\n${who(user)}\nНик TradingView: <code>${esc(user.tv || "—")}</code>\n\nУберите его в Manage access (если срок не был выставлен).`,
          reply_markup: { inline_keyboard: [[{ text: "✅ Убрал", callback_data: "removed:" + user.uid }]] } });
      } else if (left > 0 && left < 3 * DAY && !user.reminded) {
        user.reminded = true; await putUser(env, user);
        await tg(env, "sendMessage", { chat_id: user.uid, text: `Доступ к индикатору заканчивается ${till(user)}. Продлите в приложении, вкладка «Доступ», и срок добавится к текущему.` }).catch(() => {});
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// один раз: подключить вебхук Telegram и меню-кнопку
async function setup(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return new Response("нужен ?key=SETUP_KEY", { status: 403 });
  const base = url.origin;
  const out = [];
  out.push(["Вебхук Telegram", await tg(env, "setWebhook", { url: `${base}/tg/${await tgPath(env)}`, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: true }).then(() => "ок", (e) => e.message)]);
  out.push(["Кнопка меню", await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: env.WEBAPP_URL } } }).then(() => "ок", (e) => e.message)]);
  out.push(["CryptoBot токен", await crypto_(env, "getMe", {}).then((r) => "ок, приложение " + r.name, (e) => e.message)]);
  out.push(["Адрес для вебхука CryptoBot", base + "/crypto"]);
  return new Response(out.map(([a, b]) => `${a}: ${b}`).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}

// ---------- помощники ----------
async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const d = await r.json(); if (!d.ok) throw Object.assign(new Error("Telegram: " + d.description), { status: 502 });
  return d.result;
}
async function crypto_(env, method, params) {
  const r = await fetch(`https://pay.crypt.bot/api/${method}`, { method: "POST", headers: { "content-type": "application/json", "Crypto-Pay-API-Token": env.CRYPTO_TOKEN }, body: JSON.stringify(params) });
  const d = await r.json(); if (!d.ok) throw Object.assign(new Error("CryptoBot: " + JSON.stringify(d.error)), { status: 502 });
  return d.result;
}
async function checkInitData(initData, token) {
  const p = new URLSearchParams(initData), hash = p.get("hash"); if (!hash || !token) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc("WebAppData"), token);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  try { return JSON.parse(p.get("user")); } catch (e) { return null; }
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, typeof msg === "string" ? enc(msg) : msg);
}
async function tgPath(env) { return hex(await crypto.subtle.digest("SHA-256", enc("hook" + env.BOT_TOKEN))).slice(0, 32); }
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
function cors(r) { const h = new Headers(r.headers); h.set("access-control-allow-origin", "*"); h.set("access-control-allow-headers", "content-type"); h.set("access-control-allow-methods", "GET,POST,OPTIONS"); return new Response(r.body, { status: r.status, headers: h }); }
const getUser = async (env, uid) => JSON.parse((await env.DB.get("user:" + uid)) || "null");
const putUser = (env, u) => env.DB.put("user:" + u.uid, JSON.stringify(u));
const isActive = (u) => !!u && !!u.plan && u.status !== "expired" && (!u.until || u.until > Date.now());
const till = (u) => (u.until ? new Date(u.until).toLocaleDateString("ru-RU", { timeZone: "Europe/Kyiv" }) : "навсегда");
const who = (u) => `Покупатель: ${u.username ? "@" + esc(u.username) : esc(u.name || "")} (id <code>${u.uid}</code>)`;
function publicUser(u) { return { plan: u.plan || null, name: u.plan ? PLANS[u.plan].name : null, until: u.until || 0, status: u.plan ? (isActive(u) ? u.status : "expired") : null, tv: u.tv || "", freeWeek: u.freeWeek || "" }; }
// понедельник текущей недели, как в приложении
function weekId(d = new Date()) { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); }
