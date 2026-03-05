// ============================================================
// Spectux Lead Pipeline — Cloudflare Worker (index.js)
// Routes:
//   POST /lead/places    — Eindhoven bel-leads (Stroom 1)
//   POST /lead/instagram — Instagram DM-leads  (Stroom 2)
//   GET  /health         — sanity check
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simpele auth check via secret header
    const authHeader = request.headers.get("X-API-Secret");
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
};

// ─────────────────────────────────────────────
// STROOM 1 — Eindhoven bel-lead verwerken
// ─────────────────────────────────────────────
async function handlePlacesLead(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { name, url: websiteUrl, phone, pagespeed_score } = body;

  if (!name || !websiteUrl) {
    return json({ error: "name en url zijn verplicht" }, 400);
  }

  // ── Deduplicatie: al bekend?
  const existing = await env.DB.prepare(
    "SELECT id FROM places_leads WHERE url = ?"
  )
    .bind(websiteUrl)
    .first();

  if (existing) {
    return json({ status: "duplicate", message: "Lead al bekend, genegeerd." });
  }

  // ── Gemini: genereer een niet-technische openingszin
  const geminiPitch = await generatePlacesPitch(
    env.GEMINI_API_KEY,
    name,
    websiteUrl,
    pagespeed_score
  );

  // ── Opslaan in D1
  await env.DB.prepare(
    `INSERT INTO places_leads (name, url, phone, pagespeed_score, gemini_pitch)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(name, websiteUrl, phone ?? null, pagespeed_score ?? null, geminiPitch)
    .run();

  // ── Telegram notificatie
  const message =
    `📞 *NIEUWE BEL-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏢 *Bedrijf:* ${escapeMd(name)}\n` +
    `🌐 *Website:* ${escapeMd(websiteUrl)}\n` +
    `📱 *Telefoon:* ${escapeMd(phone ?? "onbekend")}\n` +
    `⚡ *PageSpeed score:* ${pagespeed_score ?? "??"}/100\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *Openingszin:*\n_${escapeMd(geminiPitch)}_`;

  await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message);

  return json({ status: "ok", gemini_pitch: geminiPitch });
}

// ─────────────────────────────────────────────
// STROOM 2 — Instagram DM-lead verwerken
// ─────────────────────────────────────────────
async function handleInstagramLead(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { username, bio, follower_count } = body;

  if (!username) {
    return json({ error: "username is verplicht" }, 400);
  }

  // ── Deduplicatie
  const existing = await env.DB.prepare(
    "SELECT id FROM instagram_leads WHERE username = ?"
  )
    .bind(username)
    .first();

  if (existing) {
    return json({ status: "duplicate", message: "Lead al bekend, genegeerd." });
  }

  // ── Gemini: genereer een informele DM
  const geminiDm = await generateInstagramDm(
    env.GEMINI_API_KEY,
    username,
    bio ?? ""
  );

  // ── Opslaan in D1
  await env.DB.prepare(
    `INSERT INTO instagram_leads (username, bio, follower_count, gemini_dm)
     VALUES (?, ?, ?, ?)`
  )
    .bind(username, bio ?? null, follower_count ?? null, geminiDm)
    .run();

  // ── Telegram notificatie
  const message =
    `📱 *NIEUWE INSTA\\-LEAD*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Username:* @${escapeMd(username)}\n` +
    `👥 *Volgers:* ${follower_count ?? "??"}\n` +
    `📝 *Bio:* _${escapeMd(bio ?? "(leeg)")}_\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💬 *DM tekst:*\n_${escapeMd(geminiDm)}_`;

  await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message);

  return json({ status: "ok", gemini_dm: geminiDm });
}

// ─────────────────────────────────────────────
// Gemini helpers
// ─────────────────────────────────────────────
async function generatePlacesPitch(apiKey, name, websiteUrl, score) {
  const prompt =
    `Jij bent een vriendelijke Nederlandse verkoopmedewerker voor Spectux, een webdesign bureau. ` +
    `Schrijf EEN korte, niet-technische openingszin (max 2 zinnen) voor een koud telefoongesprek ` +
    `met het bedrijf "${name}" (website: ${websiteUrl}). ` +
    `Hun mobiele PageSpeed score is ${score}/100, wat slecht is. ` +
    `Leg in simpele taal uit wat dit betekent voor hun klanten (bijv. langzaam laden = klanten haken af). ` +
    `Gebruik geen jargon. Klink menselijk en behulpzaam. Geef alleen de openingszin terug, geen uitleg.`;

  return callGemini(apiKey, prompt);
}

async function generateInstagramDm(apiKey, username, bio) {
  const prompt =
    `Jij bent een Nederlandse copywriter voor Spectux (spectux.com), een webdesign bureau ` +
    `dat startende ondernemers helpt aan hun eerste professionele website. ` +
    `Schrijf een super korte, informele en persoonlijke Instagram DM (max 3 zinnen) ` +
    `voor @${username}. Hun bio is: "${bio}". ` +
    `Ze hebben nog geen website. Noem spectux.com op een natuurlijke manier. ` +
    `Begin niet met "Hey" of "Hoi". Klink als een echte ondernemer, niet als een bot. ` +
    `Geef alleen de DM tekst terug, zonder uitleg of aanhalingstekens.`;

  return callGemini(apiKey, prompt);
}

async function callGemini(apiKey, prompt) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
    }),
  });

  if (!res.ok) {
    console.error("Gemini fout:", await res.text());
    return "(kon geen tekst genereren)";
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ??
    "(geen reactie van Gemini)";
}

// ─────────────────────────────────────────────
// Telegram helper
// ─────────────────────────────────────────────
async function sendTelegram(token, chatId, text) {
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    console.error("Telegram fout:", await res.text());
  }
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

// Escape speciale tekens voor Telegram MarkdownV2
function escapeMd(text) {
  return String(text).replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
