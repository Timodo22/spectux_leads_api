// ============================================================
// Spectux Lead Pipeline — Cloudflare Worker (index.js)
//
// Routes:
//   POST /lead/places          — Eindhoven/regio bel-leads (Stroom 1)
//   POST /lead/instagram       — Instagram DM-leads (Stroom 2)
//   POST /telegram-webhook     — Telegram callback knop verwerking
//   GET  /health               — sanity check
//
// Scheduled (Cron):
//   Dagelijks: verwijder leads ouder dan 30 dagen
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authHeader = request.headers.get("X-API-Secret");

    // Telegram webhook heeft geen secret header — beveiligd via Telegram zelf
    if (url.pathname === "/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (authHeader !== env.WORKER_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "spectux-leads" });
    }
    if (request.method === "POST" && url.pathname === "/lead/places") {
      return handlePlacesLead(request, env);
    }
    if (request.method === "POST" && url.pathname === "/lead/instagram") {
      return handleInstagramLead(request, env);
    }

    return json({ error: "Not found" }, 404);
  },

  // Cron Trigger: dagelijkse cleanup (zie wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

// ─────────────────────────────────────────────
// STROOM 1 — Bel-lead verwerken
// ─────────────────────────────────────────────
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

  const geminiPitch = await generatePlacesPitch(
    env.GEMINI_API_KEY, name, websiteUrl, pagespeed_score, city
  );

  const result = await env.DB.prepare(
    `INSERT INTO places_leads (name, url, phone, pagespeed_score, city, gemini_pitch)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(name, websiteUrl, phone ?? null, pagespeed_score ?? null, city ?? null, geminiPitch).run();

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
    `💬 *Openingszin:*\n_${escapeMd(geminiPitch)}_`;

  await sendTelegramWithButton(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    message,
    `done_places_${leadId}`,
    "✅ Gebeld — verwijder lead"
  );

  return json({ status: "ok", lead_id: leadId, gemini_pitch: geminiPitch });
}

// ─────────────────────────────────────────────
// STROOM 2 — Instagram lead verwerken
// ─────────────────────────────────────────────
async function handleInstagramLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { username, bio, follower_count } = body;
  if (!username) return json({ error: "username is verplicht" }, 400);

  const existing = await env.DB.prepare(
    "SELECT id FROM instagram_leads WHERE username = ?"
  ).bind(username).first();
  if (existing) return json({ status: "duplicate" });

  const geminiDm = await generateInstagramDm(env.GEMINI_API_KEY, username, bio ?? "");

  const result = await env.DB.prepare(
    `INSERT INTO instagram_leads (username, bio, follower_count, gemini_dm)
     VALUES (?, ?, ?, ?)`
  ).bind(username, bio ?? null, follower_count ?? null, geminiDm).run();

  const leadId = result.meta.last_row_id;

  const message =
    `📱 *NIEUWE INSTA\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Username:* @${escapeMd(username)}\n` +
    `👥 *Volgers:* ${follower_count ?? "??"}\n` +
    `📝 *Bio:* _${escapeMd(bio ?? "(leeg)")}_\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *DM tekst:*\n_${escapeMd(geminiDm)}_`;

  await sendTelegramWithButton(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    message,
    `done_instagram_${leadId}`,
    "✅ Gebericht — verwijder lead"
  );

  return json({ status: "ok", lead_id: leadId, gemini_dm: geminiDm });
}

// ─────────────────────────────────────────────
// TELEGRAM WEBHOOK — knop callback verwerking
// ─────────────────────────────────────────────
async function handleTelegramWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("ok"); }

  const query = body?.callback_query;
  if (!query) return new Response("ok");

  const callbackId   = query.id;
  const chatId       = query.message?.chat?.id;
  const messageId    = query.message?.message_id;
  const callbackData = query.data ?? "";

  // Formaat: done_places_123 of done_instagram_456
  const match = callbackData.match(/^done_(places|instagram)_(\d+)$/);

  if (!match) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, "Onbekende actie");
    return new Response("ok");
  }

  const type   = match[1];
  const leadId = parseInt(match[2]);
  const table  = type === "places" ? "places_leads" : "instagram_leads";

  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE id = ?`
    ).bind(leadId).first();

    if (!existing) {
      await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, "⚠️ Lead was al verwijderd");
      await editTelegramReplyMarkup(env.TELEGRAM_BOT_TOKEN, chatId, messageId);
      return new Response("ok");
    }

    // Lead verwijderen
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(leadId).run();

    // Popup bevestiging
    const successMsg = type === "places"
      ? "🗑 Lead verwijderd — succes met bellen!"
      : "🗑 Lead verwijderd — succes met DM'en!";
    await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, successMsg);

    // Verwijder de knop uit het bericht + stuur reply
    await editTelegramReplyMarkup(env.TELEGRAM_BOT_TOKEN, chatId, messageId);

    const timestamp = new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" });
    await sendTelegramReply(
      env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `✅ *Afgehandeld* op ${escapeMd(timestamp)}\\.`
    );

  } catch (err) {
    console.error("Webhook fout:", err);
    await answerCallback(env.TELEGRAM_BOT_TOKEN, callbackId, "❌ Fout bij verwijderen");
  }

  return new Response("ok");
}

// ─────────────────────────────────────────────
// CRON: verwijder leads ouder dan 30 dagen
// ─────────────────────────────────────────────
async function runCleanup(env) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString();

  const r1 = await env.DB.prepare(
    "DELETE FROM places_leads WHERE created_at < ?"
  ).bind(cutoffStr).run();

  const r2 = await env.DB.prepare(
    "DELETE FROM instagram_leads WHERE created_at < ?"
  ).bind(cutoffStr).run();

  const deleted1 = r1.meta.changes ?? 0;
  const deleted2 = r2.meta.changes ?? 0;

  console.log(`Cleanup: ${deleted1} bel-leads + ${deleted2} insta-leads verwijderd`);

  if ((deleted1 + deleted2) > 0) {
    const msg =
      `🧹 *Auto\\-cleanup*\n` +
      `${deleted1} bel\\-leads en ${deleted2} insta\\-leads ouder dan 30 dagen verwijderd\\.`;
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg);
  }
}

// ─────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────
async function generatePlacesPitch(apiKey, name, websiteUrl, score, city) {
  const prompt =
    `Jij bent een vriendelijke Nederlandse verkoopmedewerker voor Spectux, een webdesign bureau. ` +
    `Schrijf EEN korte, niet-technische openingszin (max 2 zinnen) voor een koud telefoongesprek ` +
    `met het bedrijf "${name}" uit ${city ?? "de regio Eindhoven"} (website: ${websiteUrl}). ` +
    `Hun mobiele PageSpeed score is ${score}/100, wat slecht is. ` +
    `Leg in simpele taal uit wat dit betekent voor hun klanten. ` +
    `Geen jargon. Menselijk en behulpzaam. Geef alleen de openingszin terug.`;
  return callGemini(apiKey, prompt);
}

async function generateInstagramDm(apiKey, username, bio) {
  const prompt =
    `Jij bent een Nederlandse copywriter voor Spectux (spectux.com), een webdesign bureau ` +
    `dat startende ondernemers helpt aan hun eerste professionele website. ` +
    `Schrijf een super korte, informele Instagram DM (max 3 zinnen) voor @${username}. ` +
    `Hun bio: "${bio}". Geen website. Noem spectux.com natuurlijk. ` +
    `Begin niet met "Hey" of "Hoi". Klink menselijk. Geef alleen de DM tekst terug.`;
  return callGemini(apiKey, prompt);
}

async function callGemini(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
      }),
    }
  );
  if (!res.ok) return "(kon geen tekst genereren)";
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "(geen reactie)";
}

// ─────────────────────────────────────────────
// Telegram helpers
// ─────────────────────────────────────────────
async function sendTelegramWithButton(token, chatId, text, callbackData, buttonLabel) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: buttonLabel, callback_data: callbackData }]]
      }
    }),
  });
}

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
  });
}

async function sendTelegramReply(token, chatId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_to_message_id: replyToMessageId,
    }),
  });
}

async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: true }),
  });
}

async function editTelegramReplyMarkup(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeMd(text) {
  return String(text).replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
