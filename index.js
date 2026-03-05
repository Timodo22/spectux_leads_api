// =============================================================================
// Spectux Worker — index.js
//
// Routes:
//   POST /lead/instagram          → Lead opslaan + Gemini DM + Telegram
//   POST /lead/instagram/dm       → Status update na DM versturen
//   POST /lead/instagram/status   → Algemene status update (dashboard)
//   POST /lead/places             → Google Maps bel-lead
//   POST /telegram-webhook        → Telegram knop callbacks
//   GET  /leads                   → Leads ophalen uit D1
//   GET  /health                  → Status check
//
// Zet deze secrets via: npx wrangler secret put NAAM
//   WORKER_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY
// =============================================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const secret = request.headers.get("X-API-Secret");

    if (url.pathname === "/telegram-webhook")
      return handleTelegramWebhook(request, env);

    if (secret !== env.WORKER_SECRET)
      return json({ error: "Unauthorized" }, 401);

    if (request.method === "GET"  && url.pathname === "/health")
      return json({ status: "ok" });

    if (request.method === "GET"  && url.pathname === "/leads")
      return handleGetLeads(request, env);

    if (request.method === "POST" && url.pathname === "/lead/instagram")
      return handleInstagramLead(request, env);

    if (request.method === "POST" && url.pathname === "/lead/instagram/dm")
      return handleInstagramDmSent(request, env);

    if (request.method === "POST" && url.pathname === "/lead/instagram/status")
      return handleInstagramStatus(request, env);

    if (request.method === "POST" && url.pathname === "/lead/places")
      return handlePlacesLead(request, env);

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

// =============================================================================
// INSTAGRAM LEAD — opslaan + Gemini + Telegram
// =============================================================================
async function handleInstagramLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, bio, follower_count, website, email_in_bio, source_hashtag, profile_url } = body;
  if (!username) return json({ error: "username is verplicht" }, 400);

  // Duplicate check
  const existing = await env.DB.prepare(
    "SELECT id, status FROM instagram_leads WHERE username = ?"
  ).bind(username).first();
  if (existing) return json({ status: "duplicate", lead_id: existing.id });

  // Gemini DM genereren
  const dmText = await generateDm(env.GEMINI_API_KEY, username, bio ?? "", email_in_bio ?? "", follower_count ?? 0);

  // Opslaan in D1
  const result = await env.DB.prepare(`
    INSERT INTO instagram_leads
      (username, bio, follower_count, website, email_in_bio, source_hashtag, profile_url, dm_text, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
  `).bind(username, bio ?? null, follower_count ?? null, website ?? null,
          email_in_bio ?? null, source_hashtag ?? null, profile_url ?? null, dmText).run();

  const leadId = result.meta.last_row_id;

  // Telegram bericht bouwen
  const emailLine = email_in_bio
    ? `📧 *Email in bio:* \`${esc(email_in_bio)}\`\n`
    : `🌐 *Geen website*\n`;

  const msg =
    `📱 *NIEUWE INSTA\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 [@${esc(username)}](https://instagram.com/${username})\n` +
    `👥 *Volgers:* ${follower_count ?? "??"}\n` +
    emailLine +
    `🏷 \\#${esc(source_hashtag ?? "onbekend")}\n` +
    `📝 _${esc((bio ?? "").slice(0, 200))}_\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *DM tekst:*\n_${esc(dmText)}_`;

  const tgRes = await sendTgButtons(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg, [
    [
      { text: "✅ Gecontacteerd",    callback_data: `ig_contacted_${leadId}` },
      { text: "❌ Niet interessant", callback_data: `ig_skip_${leadId}` },
    ],
    [
      { text: "🔁 Opnieuw DM'en",   callback_data: `ig_retry_${leadId}` },
      { text: "👤 Profiel",         url: `https://instagram.com/${username}` },
    ],
  ]);

  if (tgRes?.result?.message_id) {
    await env.DB.prepare("UPDATE instagram_leads SET telegram_msg_id = ? WHERE id = ?")
      .bind(tgRes.result.message_id, leadId).run();
  }

  return json({ status: "ok", lead_id: leadId, dm_text: dmText });
}

// =============================================================================
// DM VERSTUURD — status updaten
// =============================================================================
async function handleInstagramDmSent(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, dm_text } = body;
  if (!username) return json({ error: "username is verplicht" }, 400);

  await env.DB.prepare(`
    UPDATE instagram_leads
    SET status = 'dm_sent', dm_text = COALESCE(?, dm_text),
        dm_sent_at = datetime('now'), dm_count = dm_count + 1, updated_at = datetime('now')
    WHERE username = ?
  `).bind(dm_text ?? null, username).run();

  return json({ status: "ok" });
}

// =============================================================================
// STATUS UPDATE — vanuit dashboard
// =============================================================================
async function handleInstagramStatus(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, status } = body;
  if (!username || !status) return json({ error: "username en status zijn verplicht" }, 400);

  const allowed = ["new", "queued", "dm_sent", "replied", "converted", "skipped", "contacted"];
  if (!allowed.includes(status)) return json({ error: "Ongeldige status" }, 400);

  await env.DB.prepare(`
    UPDATE instagram_leads SET status = ?, updated_at = datetime('now') WHERE username = ?
  `).bind(status, username).run();

  return json({ status: "ok" });
}

// =============================================================================
// GOOGLE MAPS BEL-LEAD
// =============================================================================
async function handlePlacesLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { name, url: websiteUrl, phone, pagespeed_score, city } = body;
  if (!name || !websiteUrl) return json({ error: "name en url zijn verplicht" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM places_leads WHERE url = ?").bind(websiteUrl).first();
  if (existing) return json({ status: "duplicate" });

  const pitch = await generatePitch(env.GEMINI_API_KEY, name, websiteUrl, pagespeed_score, city);

  const result = await env.DB.prepare(`
    INSERT INTO places_leads (name, url, phone, pagespeed_score, city, gemini_pitch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(name, websiteUrl, phone ?? null, pagespeed_score ?? null, city ?? null, pitch).run();

  const leadId = result.meta.last_row_id;

  const msg =
    `📞 *NIEUWE BEL\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏢 *Bedrijf:* ${esc(name)}\n` +
    `📍 *Stad:* ${esc(city ?? "Regio Eindhoven")}\n` +
    `🌐 *Website:* ${esc(websiteUrl)}\n` +
    `📱 *Telefoon:* ${esc(phone ?? "onbekend")}\n` +
    `⚡ *PageSpeed:* ${pagespeed_score ?? "??"}/100\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *Openingszin:*\n_${esc(pitch)}_`;

  const tgRes = await sendTgButtons(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg, [
    [
      { text: "✅ Gebeld — succes!",  callback_data: `pl_contacted_${leadId}` },
      { text: "❌ Niet interessant",  callback_data: `pl_skip_${leadId}` },
    ],
    [
      { text: "🔁 Terugbellen",      callback_data: `pl_retry_${leadId}` },
      { text: "🌐 Website",          url: websiteUrl },
    ],
  ]);

  if (tgRes?.result?.message_id) {
    await env.DB.prepare("UPDATE places_leads SET telegram_msg_id = ? WHERE id = ?")
      .bind(tgRes.result.message_id, leadId).run();
  }

  return json({ status: "ok", lead_id: leadId, gemini_pitch: pitch });
}

// =============================================================================
// LEADS OPHALEN
// =============================================================================
async function handleGetLeads(request, env) {
  const url      = new URL(request.url);
  const type     = url.searchParams.get("type")     ?? "instagram";
  const status   = url.searchParams.get("status");
  const username = url.searchParams.get("username");
  const today    = url.searchParams.get("today");
  const limit    = parseInt(url.searchParams.get("limit") ?? "200");
  const table    = type === "places" ? "places_leads" : "instagram_leads";

  // Duplicate check voor scraper
  if (username) {
    const row = await env.DB.prepare(`SELECT id, status FROM ${table} WHERE username = ?`).bind(username).first();
    return json({ count: row ? 1 : 0 });
  }

  const where = [], binds = [];
  if (status && status !== "all") { where.push("status = ?"); binds.push(status); }
  if (today === "1")              { where.push("date(dm_sent_at) = date('now')"); }

  let query = `SELECT * FROM ${table}`;
  if (where.length) query += " WHERE " + where.join(" AND ");
  query += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ leads: results ?? [], count: results?.length ?? 0 });
}

// =============================================================================
// TELEGRAM WEBHOOK — knoppen verwerken
// =============================================================================
async function handleTelegramWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("ok"); }

  const query = body?.callback_query;
  if (!query) return new Response("ok");

  const callbackId = query.id;
  const chatId     = query.message?.chat?.id;
  const messageId  = query.message?.message_id;
  const data       = query.data ?? "";
  const by         = query.from?.first_name ?? "Iemand";

  const match = data.match(/^(ig|pl)_(contacted|skip|retry)_(\d+)$/);
  if (!match) {
    await answerCb(env.TELEGRAM_BOT_TOKEN, callbackId, "⚠️ Onbekende actie");
    return new Response("ok");
  }

  const prefix = match[1];
  const action = match[2];
  const leadId = parseInt(match[3]);
  const table  = prefix === "ig" ? "instagram_leads" : "places_leads";

  const lead = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(leadId).first();
  if (!lead) {
    await answerCb(env.TELEGRAM_BOT_TOKEN, callbackId, "⚠️ Lead niet gevonden");
    await removeTgButtons(env.TELEGRAM_BOT_TOKEN, chatId, messageId);
    return new Response("ok");
  }

  const statusMap = {
    contacted: { status: "contacted", emoji: "✅", msg: "Gemarkeerd als gecontacteerd!" },
    skip:      { status: "skipped",   emoji: "❌", msg: "Lead overgeslagen." },
    retry:     { status: "queued",    emoji: "🔁", msg: "Terug in wachtrij!" },
  };
  const { status: newStatus, emoji, msg } = statusMap[action];

  await env.DB.prepare(`UPDATE ${table} SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(newStatus, leadId).run();

  await answerCb(env.TELEGRAM_BOT_TOKEN, callbackId, msg);
  await removeTgButtons(env.TELEGRAM_BOT_TOKEN, chatId, messageId);

  const ts         = new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" });
  const identifier = prefix === "ig" ? `@${esc(lead.username)}` : esc(lead.name ?? "lead");

  await sendTgReply(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
    `${emoji} *${esc(msg)}*\n👤 ${identifier}\n🕐 ${esc(ts)}\n👆 ${esc(by)}`
  );

  return new Response("ok");
}

// =============================================================================
// CLEANUP
// =============================================================================
async function runCleanup(env) {
  const r1 = await env.DB.prepare("DELETE FROM instagram_leads WHERE created_at < datetime('now', '-60 days')").run();
  const r2 = await env.DB.prepare("DELETE FROM places_leads    WHERE created_at < datetime('now', '-60 days')").run();
  const total = (r1.meta.changes ?? 0) + (r2.meta.changes ?? 0);
  if (total > 0) {
    await sendTg(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
      `🧹 *Cleanup:* ${total} leads ouder dan 60 dagen verwijderd\\.`);
  }
}

// =============================================================================
// GEMINI
// =============================================================================
async function generateDm(apiKey, username, bio, emailInBio, followers) {
  const ctx = emailInBio
    ? `Ze gebruiken ${emailInBio} als contactmail — niet professioneel.`
    : "Ze hebben geen website.";
  return callGemini(apiKey,
    `Jij bent copywriter voor Spectux (spectux.com), een Nederlands webdesign bureau voor startende ondernemers. ` +
    `Schrijf een ultra-korte Instagram DM (max 2-3 zinnen) voor @${username}. ${ctx} Bio: "${bio.slice(0,150)}". ` +
    `${followers} volgers. Noem spectux.com op een natuurlijke manier. ` +
    `Begin NIET met Hey/Hoi/Hi/Hallo. Klink menselijk. Geef alleen de DM tekst.`
  );
}

async function generatePitch(apiKey, name, url, score, city) {
  return callGemini(apiKey,
    `Jij bent verkoopmedewerker voor Spectux (webdesign bureau). ` +
    `Schrijf EEN openingszin (max 2 zinnen) voor een koud telefoongesprek met "${name}" uit ${city ?? "Eindhoven"}. ` +
    `Website: ${url}. PageSpeed: ${score}/100 (slecht). Geen jargon. Menselijk. Geef alleen de zin.`
  );
}

async function callGemini(apiKey, prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.85 } }) }
    );
    if (!res.ok) return "(kon geen tekst genereren)";
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "(geen reactie)";
  } catch { return "(Gemini onbereikbaar)"; }
}

// =============================================================================
// TELEGRAM HELPERS
// =============================================================================
async function sendTgButtons(token, chatId, text, keyboard) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2",
      disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } }),
  });
  return res.json();
}

async function sendTg(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
  });
}

async function sendTgReply(token, chatId, replyToId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2", reply_to_message_id: replyToId }),
  });
}

async function answerCb(token, cbId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: true }),
  });
}

async function removeTgButtons(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
}

// =============================================================================
// UTILS
// =============================================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function esc(text) {
  return String(text ?? "").replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
