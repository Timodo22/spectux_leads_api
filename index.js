// =============================================================================
// Spectux Leads Worker — index.js  (v2)
//
// Routes:
//   POST /lead/instagram      — Nieuwe Instagram lead opslaan + Telegram sturen
//   POST /lead/places         — Bestaande bel-lead flow
//   POST /lead/instagram/dm   — Update: DM verstuurd (vanuit lokale bot)
//   POST /telegram-webhook    — Telegram callback-knoppen verwerken
//   GET  /leads               — Alle leads ophalen (voor lokaal dashboard)
//   GET  /health              — Statuscheck
//
// Telegram knoppen per Instagram lead:
//   ✅ Gecontacteerd    → status = contacted
//   ❌ Niet interessant → status = skipped
//   🔁 Opnieuw DM'en   → zet terug op queued
// =============================================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const secret = request.headers.get("X-API-Secret");

    // Telegram webhook: geen secret nodig (beveiligd via Telegram zelf)
    if (url.pathname === "/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }

    // Alle andere routes vereisen de secret header
    if (secret !== env.WORKER_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── Routes ──────────────────────────────────────────────────────────────
    if (request.method === "GET"  && url.pathname === "/health")
      return json({ status: "ok", service: "spectux-leads-v2" });

    if (request.method === "GET"  && url.pathname === "/leads")
      return handleGetLeads(request, env);

    if (request.method === "POST" && url.pathname === "/lead/instagram")
      return handleInstagramLead(request, env);

    if (request.method === "POST" && url.pathname === "/lead/instagram/dm")
      return handleInstagramDmSent(request, env);

    if (request.method === "POST" && url.pathname === "/lead/places")
      return handlePlacesLead(request, env);

    return json({ error: "Not found" }, 404);
  },

  // Dagelijkse cleanup van leads ouder dan 60 dagen
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

// =============================================================================
// INSTAGRAM LEAD — Opslaan + Telegram notificatie
// =============================================================================
async function handleInstagramLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, bio, follower_count, website, email_in_bio,
          source_hashtag, profile_url } = body;

  if (!username) return json({ error: "username is verplicht" }, 400);

  // ── Duplicate check ──────────────────────────────────────────────────────
  const existing = await env.DB.prepare(
    "SELECT id, status FROM instagram_leads WHERE username = ?"
  ).bind(username).first();

  if (existing) {
    return json({ status: "duplicate", lead_id: existing.id, current_status: existing.status });
  }

  // ── Genereer DM tekst via Gemini ─────────────────────────────────────────
  const dmText = await generateInstagramDm(
    env.GEMINI_API_KEY, username, bio ?? "", email_in_bio ?? "", follower_count ?? 0
  );

  // ── Opslaan in D1 ────────────────────────────────────────────────────────
  const result = await env.DB.prepare(`
    INSERT INTO instagram_leads
      (username, bio, follower_count, website, email_in_bio, source_hashtag, profile_url, dm_text, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
  `).bind(
    username, bio ?? null, follower_count ?? null, website ?? null,
    email_in_bio ?? null, source_hashtag ?? null, profile_url ?? null, dmText
  ).run();

  const leadId = result.meta.last_row_id;

  // ── Telegram bericht met 3 knoppen ───────────────────────────────────────
  const message = buildInstagramMessage(
    username, bio, follower_count, email_in_bio, source_hashtag, dmText
  );

  const telegramRes = await sendTelegramWithButtons(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    message,
    [
      // Rij 1: hoofd-acties
      [
        { text: "✅ Gecontacteerd",     callback_data: `ig_contacted_${leadId}` },
        { text: "❌ Niet interessant",  callback_data: `ig_skip_${leadId}` },
      ],
      // Rij 2: extra
      [
        { text: "🔁 Opnieuw DM'en",    callback_data: `ig_retry_${leadId}` },
        { text: "👤 Profiel bekijken", url: `https://instagram.com/${username}` },
      ],
    ]
  );

  // Sla Telegram message_id op (voor latere knop-updates)
  if (telegramRes?.result?.message_id) {
    await env.DB.prepare(
      "UPDATE instagram_leads SET telegram_msg_id = ? WHERE id = ?"
    ).bind(telegramRes.result.message_id, leadId).run();
  }

  return json({ status: "ok", lead_id: leadId, dm_text: dmText });
}

// =============================================================================
// INSTAGRAM DM VERZONDEN — Status update vanuit lokale bot
// =============================================================================
async function handleInstagramDmSent(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, dm_text } = body;
  if (!username) return json({ error: "username is verplicht" }, 400);

  await env.DB.prepare(`
    UPDATE instagram_leads
    SET status = 'dm_sent',
        dm_text = COALESCE(?, dm_text),
        dm_sent_at = datetime('now'),
        dm_count = dm_count + 1,
        updated_at = datetime('now')
    WHERE username = ?
  `).bind(dm_text ?? null, username).run();

  // Update de Telegram knop tekst
  const lead = await env.DB.prepare(
    "SELECT telegram_msg_id FROM instagram_leads WHERE username = ?"
  ).bind(username).first();

  if (lead?.telegram_msg_id) {
    // Voeg "📤 DM verstuurd" toe aan de knoppen
    await updateTelegramCaption(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      lead.telegram_msg_id,
      `📤 DM verstuurd naar @${escapeMd(username)}\\.`
    );
  }

  return json({ status: "ok" });
}

// =============================================================================
// GOOGLE MAPS BEL-LEAD (bestaande flow, nu met D1)
// =============================================================================
async function handlePlacesLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { name, url: websiteUrl, phone, pagespeed_score, city } = body;
  if (!name || !websiteUrl) return json({ error: "name en url zijn verplicht" }, 400);

  const existing = await env.DB.prepare(
    "SELECT id FROM places_leads WHERE url = ?"
  ).bind(websiteUrl).first();
  if (existing) return json({ status: "duplicate" });

  const pitch = await generatePlacesPitch(
    env.GEMINI_API_KEY, name, websiteUrl, pagespeed_score, city
  );

  const result = await env.DB.prepare(`
    INSERT INTO places_leads (name, url, phone, pagespeed_score, city, gemini_pitch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(name, websiteUrl, phone ?? null, pagespeed_score ?? null, city ?? null, pitch).run();

  const leadId = result.meta.last_row_id;

  const message =
    `📞 *NIEUWE BEL\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏢 *Bedrijf:* ${escapeMd(name)}\n` +
    `📍 *Stad:* ${escapeMd(city ?? "Regio Eindhoven")}\n` +
    `🌐 *Website:* ${escapeMd(websiteUrl)}\n` +
    `📱 *Telefoon:* ${escapeMd(phone ?? "onbekend")}\n` +
    `⚡ *PageSpeed:* ${pagespeed_score ?? "??"}/100\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *Openingszin:*\n_${escapeMd(pitch)}_`;

  const tgRes = await sendTelegramWithButtons(
    env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message,
    [
      [
        { text: "✅ Gebeld — succes!",    callback_data: `pl_contacted_${leadId}` },
        { text: "❌ Niet interessant",    callback_data: `pl_skip_${leadId}` },
      ],
      [
        { text: "🔁 Terugbellen",        callback_data: `pl_retry_${leadId}` },
        { text: "🌐 Website bekijken",   url: websiteUrl },
      ],
    ]
  );

  if (tgRes?.result?.message_id) {
    await env.DB.prepare(
      "UPDATE places_leads SET telegram_msg_id = ? WHERE id = ?"
    ).bind(tgRes.result.message_id, leadId).run();
  }

  return json({ status: "ok", lead_id: leadId, gemini_pitch: pitch });
}

// =============================================================================
// LEADS OPHALEN — voor lokaal dashboard
// =============================================================================
async function handleGetLeads(request, env) {
  const url    = new URL(request.url);
  const type   = url.searchParams.get("type")   ?? "instagram";
  const status = url.searchParams.get("status");
  const limit  = parseInt(url.searchParams.get("limit") ?? "200");

  const table = type === "places" ? "places_leads" : "instagram_leads";

  let query = `SELECT * FROM ${table}`;
  const binds = [];

  if (status && status !== "all") {
    query += " WHERE status = ?";
    binds.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ leads: results, count: results.length });
}

// =============================================================================
// TELEGRAM WEBHOOK — Knoppen verwerken
// =============================================================================
async function handleTelegramWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("ok"); }

  const query = body?.callback_query;
  if (!query) return new Response("ok");

  const callbackId   = query.id;
  const chatId       = query.message?.chat?.id;
  const messageId    = query.message?.message_id;
  const data         = query.data ?? "";
  const clickedBy    = query.from?.first_name ?? "Iemand";

  // ── Parse callback data ──────────────────────────────────────────────────
  // Formaat: ig_contacted_123 / ig_skip_123 / ig_retry_123
  //          pl_contacted_123 / pl_skip_123 / pl_retry_123
  const match = data.match(/^(ig|pl)_(contacted|skip|retry)_(\d+)$/);

  if (!match) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, "⚠️ Onbekende actie");
    return new Response("ok");
  }

  const prefix = match[1]; // ig of pl
  const action = match[2]; // contacted, skip, retry
  const leadId = parseInt(match[3]);
  const table  = prefix === "ig" ? "instagram_leads" : "places_leads";

  // ── Controleer of lead bestaat ───────────────────────────────────────────
  const lead = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id = ?`
  ).bind(leadId).first();

  if (!lead) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, "⚠️ Lead niet gevonden");
    await removeTelegramButtons(env.TELEGRAM_BOT_TOKEN, chatId, messageId);
    return new Response("ok");
  }

  // ── Actie uitvoeren ──────────────────────────────────────────────────────
  const actionMap = {
    contacted: { status: "contacted", emoji: "✅", msg: "Gemarkeerd als gecontacteerd!" },
    skip:      { status: "skipped",   emoji: "❌", msg: "Lead overgeslagen." },
    retry:     { status: "queued",    emoji: "🔁", msg: "Terug in wachtrij gezet!" },
  };

  const { status: newStatus, emoji, msg } = actionMap[action];

  await env.DB.prepare(`
    UPDATE ${table}
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(newStatus, leadId).run();

  // Log de actie
  await env.DB.prepare(`
    INSERT INTO telegram_actions (lead_type, lead_id, action)
    VALUES (?, ?, ?)
  `).bind(prefix, leadId, action).run();

  // ── Telegram feedback ────────────────────────────────────────────────────
  await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, msg);

  // Verwijder de knoppen + voeg timestamp toe
  await removeTelegramButtons(env.TELEGRAM_BOT_TOKEN, chatId, messageId);

  const ts = new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" });
  const identifier = prefix === "ig"
    ? `@${escapeMd(lead.username)}`
    : escapeMd(lead.name ?? "lead");

  await sendTelegramReply(
    env.TELEGRAM_BOT_TOKEN, chatId, messageId,
    `${emoji} *${escapeMd(msg)}*\n` +
    `👤 ${identifier}\n` +
    `🕐 ${escapeMd(ts)}\n` +
    `👆 Door: ${escapeMd(clickedBy)}`
  );

  return new Response("ok");
}

// =============================================================================
// CLEANUP — leads ouder dan 60 dagen
// =============================================================================
async function runCleanup(env) {
  const r1 = await env.DB.prepare(
    "DELETE FROM instagram_leads WHERE created_at < datetime('now', '-60 days')"
  ).run();
  const r2 = await env.DB.prepare(
    "DELETE FROM places_leads WHERE created_at < datetime('now', '-60 days')"
  ).run();

  const total = (r1.meta.changes ?? 0) + (r2.meta.changes ?? 0);
  if (total > 0) {
    await sendTelegram(
      env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
      `🧹 *Auto\\-cleanup:* ${total} leads ouder dan 60 dagen verwijderd\\.`
    );
  }
}

// =============================================================================
// GEMINI helpers
// =============================================================================
async function generateInstagramDm(apiKey, username, bio, emailInBio, followers) {
  const emailCtx = emailInBio
    ? `Ze gebruiken nog ${emailInBio} als contactmail — niet professioneel.`
    : "Ze hebben geen professionele website.";

  const prompt =
    `Jij bent copywriter voor Spectux (spectux.com), een Nederlands webdesign bureau ` +
    `voor startende ondernemers. Schrijf een ultra-korte Instagram DM (max 2-3 zinnen) ` +
    `voor @${username}. ${emailCtx} Bio: "${bio.slice(0, 150)}". ` +
    `${followers} volgers. Noem spectux.com op een heel natuurlijke manier. ` +
    `Begin NIET met Hey/Hoi/Hi/Hallo. Klink menselijk. Geef alleen de DM tekst.`;

  return callGemini(apiKey, prompt);
}

async function generatePlacesPitch(apiKey, name, url, score, city) {
  const prompt =
    `Jij bent verkoopmedewerker voor Spectux (webdesign bureau). ` +
    `Schrijf EEN openingszin (max 2 zinnen) voor een koud telefoongesprek ` +
    `met "${name}" uit ${city ?? "Eindhoven"} (website: ${url}). ` +
    `Hun PageSpeed score: ${score}/100 (slecht). Geen jargon. ` +
    `Menselijk en behulpzaam. Geef alleen de openingszin.`;
  return callGemini(apiKey, prompt);
}

async function callGemini(apiKey, prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.85 },
        }),
      }
    );
    if (!res.ok) return "(kon geen tekst genereren)";
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "(geen reactie)";
  } catch {
    return "(Gemini onbereikbaar)";
  }
}

// =============================================================================
// Telegram helpers
// =============================================================================

// Bericht met inline keyboard (array van arrays = rijen met knoppen)
async function sendTelegramWithButtons(token, chatId, text, keyboard) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:   chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
  return res.json();
}

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
  });
}

async function sendTelegramReply(token, chatId, replyToId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "MarkdownV2",
      reply_to_message_id: replyToId,
    }),
  });
}

async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: true,
    }),
  });
}

async function removeTelegramButtons(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}

async function updateTelegramCaption(token, chatId, messageId, appendText) {
  // Stuur een reply met de update (eenvoudiger dan het bericht editen)
  await sendTelegramReply(token, chatId, messageId, appendText);
}

// =============================================================================
// Bericht builder
// =============================================================================
function buildInstagramMessage(username, bio, followers, emailInBio, hashtag, dmText) {
  const emailLine = emailInBio
    ? `📧 *Email in bio:* \`${escapeMd(emailInBio)}\`\n`
    : `🌐 *Geen website gevonden*\n`;

  return (
    `📱 *NIEUWE INSTA\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Account:* [@${escapeMd(username)}](https://instagram.com/${username})\n` +
    `👥 *Volgers:* ${followers ?? "??"}\n` +
    emailLine +
    `🏷 *Hashtag:* \\#${escapeMd(hashtag ?? "onbekend")}\n` +
    `📝 *Bio:*\n_${escapeMd((bio ?? "(leeg)").slice(0, 200))}_\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *Gegenereerde DM:*\n_${escapeMd(dmText)}_`
  );
}

// =============================================================================
// Utility
// =============================================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeMd(text) {
  return String(text ?? "").replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
