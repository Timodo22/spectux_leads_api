/**
 * Spectux Leads Worker — v2
 *
 * WIJZIGINGEN t.o.v. v1:
 *  - Telegram berichten hebben nu een inline "✅ Ik heb dit DM gestuurd" knop
 *  - Telegram webhook handler (/webhook/telegram) voor knop callbacks
 *  - Setup-webhook route (/api/admin/telegram/setup-webhook)
 *  - Handmatige cleanup verwijdert nu ALLE gecontacteerde leads (niet enkel 2+ dagen oud)
 *  - Testlead route toegevoegd (/api/admin/leads/test)
 *  - Settings routes toegevoegd (/api/admin/settings GET + POST)
 *
 * ── VEREISTE DB MIGRATIE (eenmalig in Cloudflare D1 console) ─────────────────
 *
 *   ALTER TABLE instagram_leads ADD COLUMN contacted_at TEXT;
 *
 *   CREATE TABLE IF NOT EXISTS admin_stats (
 *     key   TEXT PRIMARY KEY,
 *     value INTEGER DEFAULT 0
 *   );
 *   INSERT OR IGNORE INTO admin_stats (key, value) VALUES ('total_contacted', 0);
 *
 *   CREATE TABLE IF NOT EXISTS worker_settings (
 *     key   TEXT PRIMARY KEY,
 *     value TEXT
 *   );
 *
 * ── NA DEPLOYEN: klik "Setup Webhook" in het dashboard ───────────────────────
 *   Dit koppelt Telegram aan jouw worker zodat de inline knop werkt.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const isAuthed = (req) =>
      req.headers.get("Authorization") === `Bearer ${env.ADMIN_SECRET}`;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const unauthorized = () => json({ error: "Unauthorized" }, 401);

    // ── WORKER URL (voor webhook setup) ──────────────────────────────────────
    const workerUrl = `https://${url.hostname}`;

    // ── AUTO CLEANUP: verwijder leads ouder dan 2 dagen na contact ────────────
    const runAutoCleanup = async () => {
      try {
        const result = await env.DB.prepare(`
          DELETE FROM instagram_leads
          WHERE status = 'gecontacteerd'
            AND contacted_at IS NOT NULL
            AND contacted_at < datetime('now', '-2 days')
        `).run();
        return result.changes || 0;
      } catch (e) {
        console.error("Auto cleanup fout:", e);
        return 0;
      }
    };

    // ── HANDMATIGE CLEANUP: verwijder ALLE gecontacteerde leads ───────────────
    const runManualCleanup = async () => {
      try {
        const result = await env.DB.prepare(`
          DELETE FROM instagram_leads WHERE status = 'gecontacteerd'
        `).run();
        return result.changes || 0;
      } catch (e) {
        console.error("Handmatige cleanup fout:", e);
        return 0;
      }
    };

    // ── SETTINGS HELPERS ─────────────────────────────────────────────────────
    const getSetting = async (key, fallback = null) => {
      try {
        const row = await env.DB.prepare(
          `SELECT value FROM worker_settings WHERE key = ?`
        ).bind(key).first();
        return row?.value ?? fallback;
      } catch { return fallback; }
    };

    const setSetting = async (key, value) => {
      await env.DB.prepare(
        `INSERT INTO worker_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, String(value)).run();
    };

    // ── DEFAULT GEMINI PROMPT ─────────────────────────────────────────────────
    const DEFAULT_PROMPT = `Je bent eigenaar van Spectux webdesign (spectux.com). Schrijf een KORTE informele Instagram DM in het Nederlands naar een startende ondernemer met gebruikersnaam @{{username}} en bio: "{{biography}}". Feliciteer ze specifiek op iets uit hun bio. Vraag dan casual of ze al nadenken over een professionele website. Max 3 zinnen. Geen hashtags. Klinkt menselijk, niet als spam.`;

    // ── KWALITEITSSCORE ───────────────────────────────────────────────────────
    const berekenScore = (lead) => {
      let score = 0;
      const bio = (lead.biography || "").toLowerCase();
      const url = (lead.externalUrl || "").toLowerCase();

      const starterKeywords = ["gestart", "geopend", "zzp", "ondernemer", "zelfstandig", "eigen bedrijf", "nieuw bedrijf", "freelance", "freelancer", "opgestart", "begonnen"];
      const brancheKeywords = ["kapper", "salon", "coach", "bakker", "fotograaf", "stylist", "nagelstudio", "schoonheidsspecialist", "personal trainer", "yoga", "masseur", "thuisbezorgd", "catering", "boekhouder", "schilder", "loodgieter", "dakdekker", "timmerman", "bloemist", "slager", "rijschool", "dierenoppas"];
      const ondernKeywords = ["#zzp", "#eigenbaas", "#ondernemer", "#startend", "#freelance", "#zelfstandig"];

      if (starterKeywords.some(k => bio.includes(k))) score += 20;
      if (brancheKeywords.some(k => bio.includes(k))) score += 15;
      if (!url || url === "") score += 15;
      if (bio.length > 60) score += 10;
      if (ondernKeywords.some(k => bio.includes(k))) score += 10;
      if (bio.includes("website") || bio.includes("www.") || url !== "") score -= 30;
      if (bio.length < 20) score -= 20;

      return score;
    };

    // ── TELEGRAM: stuur bericht ZONDER knop ──────────────────────────────────
    const stuurTelegram = async (tekst) => {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: tekst,
            parse_mode: "Markdown",
          }),
        }
      );
      return res.json();
    };

    // ── TELEGRAM: stuur bericht MET inline knop ──────────────────────────────
    const stuurTelegramMetKnop = async (tekst, leadId) => {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: tekst,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                {
                  text: "✅ Ik heb dit DM gestuurd",
                  callback_data: `contacted:${leadId}`,
                },
              ]],
            },
          }),
        }
      );
      return res.json();
    };

    // ── TELEGRAM: bewerk bestaand bericht (na klikken knop) ──────────────────
    const bewerkTelegramBericht = async (chatId, messageId, nieuweTekst) => {
      await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: nieuweTekst,
            parse_mode: "Markdown",
          }),
        }
      );
    };

    // ── TELEGRAM: beantwoord callback query (verwijdert laadspinner) ─────────
    const beantwoordCallback = async (callbackQueryId, tekst = "") => {
      await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: tekst,
            show_alert: false,
          }),
        }
      );
    };

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /webhook/telegram — Telegram callback (inline knop klik)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      try {
        const body = await request.json();

        if (body.callback_query) {
          const cq = body.callback_query;
          const data = cq.data || "";

          if (data.startsWith("contacted:")) {
            const leadId = data.replace("contacted:", "");

            // Haal lead op
            const lead = await env.DB.prepare(
              `SELECT * FROM instagram_leads WHERE id = ?`
            ).bind(leadId).first();

            if (lead && lead.status !== "gecontacteerd" && lead.status !== "klant") {
              // Update status
              await env.DB.prepare(
                `UPDATE instagram_leads
                 SET status = 'gecontacteerd', contacted_at = datetime('now')
                 WHERE id = ?`
              ).bind(leadId).run();

              // +1 counter
              let newCount = 0;
              try {
                await env.DB.prepare(
                  `INSERT INTO admin_stats (key, value) VALUES ('total_contacted', 1)
                   ON CONFLICT(key) DO UPDATE SET value = value + 1`
                ).run();
                const stat = await env.DB.prepare(
                  `SELECT value FROM admin_stats WHERE key = 'total_contacted'`
                ).first();
                newCount = stat?.value || 1;
              } catch (e) { console.error("Counter fout:", e); }

              // Bewerk het Telegram bericht (verwijder knop, toon bevestiging)
              await bewerkTelegramBericht(
                cq.message.chat.id,
                cq.message.message_id,
                `✅ *DM verstuurd naar @${lead.username}*\n\n` +
                `📨 Bericht: \`${lead.ai_message}\`\n\n` +
                `🗑️ Lead wordt in 2 dagen automatisch verwijderd.\n` +
                `📊 Totaal gecontacteerd: *${newCount}*`
              );
            } else if (lead) {
              // Al gecontacteerd
              await bewerkTelegramBericht(
                cq.message.chat.id,
                cq.message.message_id,
                `✅ *@${lead.username} was al gemarkeerd als gecontacteerd.*`
              );
            }

            // Beantwoord de callback query (verwijdert laadspinner in Telegram)
            await beantwoordCallback(cq.id, lead ? "Gemarkeerd! 👍" : "Lead niet gevonden.");
          }
        }

        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error("Telegram webhook fout:", e);
        return new Response("OK", { status: 200 }); // Altijd 200 teruggeven aan Telegram
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /webhook/apify — Nieuwe leads ontvangen van Apify
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/webhook/apify") {
      try {
        const apifyData = await request.json();
        // Apify stuurt data als { items: [...] } of direct als array
        const leads = apifyData.items || (Array.isArray(apifyData) ? apifyData : []);
        let nieuwCount = 0;
        let overslaanCount = 0;

        const filterEnabled = (await getSetting("lead_filter_enabled", "true")) !== "false";
        const geminiPrompt = await getSetting("gemini_prompt", DEFAULT_PROMPT);

        for (const lead of leads) {
          // Sla over als de lead al een externe website heeft
          if (lead.externalUrl && lead.externalUrl !== "") {
            overslaanCount++;
            continue;
          }

          // Kwaliteitsfilter
          if (filterEnabled) {
            const score = berekenScore(lead);
            if (score < 40) {
              overslaanCount++;
              continue;
            }
          }

          // Controleer op duplicaat
          const existing = await env.DB.prepare(
            "SELECT id FROM instagram_leads WHERE username = ?"
          ).bind(lead.username).first();
          if (existing) continue;

          // Genereer DM met Gemini
          let dmTekst =
            `Hoi! Gefeliciteerd met je start. Ik zag je bio en vroeg me af: heb je al nagedacht over een website voor ${lead.fullName || "je bedrijf"}? 😊`;

          try {
            const prompt = geminiPrompt
              .replace(/\{\{username\}\}/g, lead.username || "")
              .replace(/\{\{biography\}\}/g, lead.biography || "");

            const geminiResponse = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                }),
              }
            );
            const geminiData = await geminiResponse.json();
            const gegenereerd = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (gegenereerd) dmTekst = gegenereerd.trim();
          } catch (e) {
            console.error("Gemini fout:", e);
          }

          // Sla op in database
          const leadId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO instagram_leads (id, username, full_name, biography, ai_message, status)
             VALUES (?, ?, ?, ?, ?, 'nieuw')`
          ).bind(leadId, lead.username, lead.fullName || "", lead.biography || "", dmTekst).run();

          nieuwCount++;

          // Stuur Telegram bericht MET inline knop
          try {
            await stuurTelegramMetKnop(
              `🚀 *Nieuwe Lead: @${lead.username}*\n\n` +
              `📝 *Bio:* ${lead.biography || "—"}\n\n` +
              `💬 *Stuur dit DM:*\n\`${dmTekst}\`\n\n` +
              `_Druk op de knop hieronder nadat je het DM hebt verstuurd._`,
              leadId
            );
          } catch (e) {
            console.error("Telegram fout:", e);
          }
        }

        return json({ success: true, nieuw: nieuwCount, overgeslagen: overslaanCount });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: GET /api/admin/leads — Leads ophalen
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/api/admin/leads") {
      if (!isAuthed(request)) return unauthorized();

      ctx.waitUntil(runAutoCleanup());

      try {
        const { results } = await env.DB.prepare(
          `SELECT * FROM instagram_leads ORDER BY created_at DESC LIMIT 200`
        ).all();

        let totalContacted = 0;
        try {
          const stat = await env.DB.prepare(
            `SELECT value FROM admin_stats WHERE key = 'total_contacted'`
          ).first();
          totalContacted = stat?.value || 0;
        } catch (e) { /* migratie nog niet uitgevoerd */ }

        return json({ leads: results, total_contacted: totalContacted });
      } catch (err) {
        return json({ error: "Database fout: " + err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /api/admin/leads/test — Testlead aanmaken
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/admin/leads/test") {
      if (!isAuthed(request)) return unauthorized();

      const testUsernames = ["jan_bakker_leiden", "salon_beauty_roos", "fotograaf_tim_ams", "zzp_schilder_piet", "coach_lisa_utrecht"];
      const testBios = [
        "🎂 Pas mijn eigen bakkerij geopend in Leiden! Specialiteit: taarten op maat. DM voor bestellingen 🍰 #eigenbaas #zzp",
        "✂️ Zojuist mijn eigen kapsalon geopend! Specialisatie in kleurbehandelingen. Afspraak maken via DM 💇‍♀️ #kapper #zelfstandig",
        "📸 Startend fotograaf gespecialiseerd in bedrijfsfotografie en portrets. Beschikbaar in heel NL #freelance #fotografie",
        "🎨 Zelfstandig schilder, pas begonnen! Woningontruiming, nieuwbouw, renovatie. Bel of DM voor offerte #zzp #schilder",
        "🏃 Personal coach & lifestyle begeleider. Pas mijn eigen praktijk gestart in Utrecht! #coach #ondernemer #zelfstandig",
      ];

      const idx = Math.floor(Math.random() * testUsernames.length);
      const username = testUsernames[idx] + "_" + Math.floor(Math.random() * 9999);
      const biography = testBios[idx];
      const leadId = crypto.randomUUID();

      const debug: Record<string, any> = {};

      // Sla op in DB
      try {
        await env.DB.prepare(
          `INSERT INTO instagram_leads (id, username, full_name, biography, ai_message, status)
           VALUES (?, ?, ?, ?, ?, 'nieuw')`
        ).bind(
          leadId,
          username,
          "Test Gebruiker",
          biography,
          `Hoi! Gefeliciteerd met je start! 🎉 Ik zag je bio en dacht meteen: zo iemand verdient een professionele website. Heb je daar al over nagedacht? 😊`,
        ).run();
        debug.db = { ok: true };
      } catch (e: any) {
        debug.db = { ok: false, fout: e.message };
        return json({ success: false, debug });
      }

      // Stuur Telegram met knop
      try {
        const tgRes = await stuurTelegramMetKnop(
          `🧪 *TESTLEAD: @${username}*\n\n` +
          `📝 *Bio:* ${biography}\n\n` +
          `💬 *DM:*\n\`Hoi! Gefeliciteerd met je start! 🎉 Heb je al nagedacht over een website? 😊\`\n\n` +
          `_Dit is een testlead — druk de knop om te testen._`,
          leadId
        );
        if (tgRes.ok) {
          debug.telegram = { ok: true, message_id: tgRes.result?.message_id };
        } else {
          debug.telegram = {
            ok: false,
            fout: tgRes.description || "Onbekende Telegram fout",
            tip: tgRes.description?.includes("chat not found")
              ? "Chat ID klopt niet of bot zit niet in de groep."
              : tgRes.description?.includes("bot was kicked")
              ? "Bot is uit de groep verwijderd — voeg hem opnieuw toe."
              : "Kijk bij Telegram → Setup Webhook en Test Verbinding.",
          };
        }
      } catch (e: any) {
        debug.telegram = { ok: false, fout: e.message };
      }

      return json({ success: true, username, lead_id: leadId, debug });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /api/admin/leads/:id/contacted — DM gestuurd (dashboard)
    // ──────────────────────────────────────────────────────────────────────────
    const contactedMatch = url.pathname.match(/^\/api\/admin\/leads\/([^/]+)\/contacted$/);
    if (request.method === "POST" && contactedMatch) {
      if (!isAuthed(request)) return unauthorized();

      const leadId = contactedMatch[1];

      try {
        const lead = await env.DB.prepare(
          `SELECT * FROM instagram_leads WHERE id = ?`
        ).bind(leadId).first();

        if (!lead) return json({ error: "Lead niet gevonden" }, 404);

        await env.DB.prepare(
          `UPDATE instagram_leads
           SET status = 'gecontacteerd', contacted_at = datetime('now')
           WHERE id = ?`
        ).bind(leadId).run();

        let newCount = 0;
        try {
          await env.DB.prepare(
            `INSERT INTO admin_stats (key, value) VALUES ('total_contacted', 1)
             ON CONFLICT(key) DO UPDATE SET value = value + 1`
          ).run();
          const stat = await env.DB.prepare(
            `SELECT value FROM admin_stats WHERE key = 'total_contacted'`
          ).first();
          newCount = stat?.value || 1;
        } catch (e) { console.error("Counter fout:", e); }

        try {
          await stuurTelegram(
            `✅ *DM Verstuurd naar @${lead.username}* (via dashboard)\n\n` +
            `📨 Bericht: \`${lead.ai_message}\`\n\n` +
            `🗑️ Lead wordt in 2 dagen automatisch verwijderd.\n` +
            `📊 Totaal gecontacteerd: *${newCount}*`
          );
        } catch (e) { console.error("Telegram fout:", e); }

        const deleteAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

        return json({
          success: true,
          username: lead.username,
          total_contacted: newCount,
          delete_at: deleteAt.toISOString(),
        });
      } catch (err) {
        return json({ error: "Database fout: " + err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: PATCH /api/admin/leads/:id — Status dropdown update
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "PATCH" && url.pathname.match(/^\/api\/admin\/leads\/[^/]+$/)) {
      if (!isAuthed(request)) return unauthorized();

      const leadId = url.pathname.split("/").pop();

      try {
        const { status } = await request.json();
        const toegestaan = ["nieuw", "gecontacteerd", "geïnteresseerd", "niet_geïnteresseerd", "klant"];

        if (!toegestaan.includes(status)) {
          return json({ error: `Ongeldige status. Toegestaan: ${toegestaan.join(", ")}` }, 400);
        }

        const extraSet = status === "gecontacteerd" ? ", contacted_at = datetime('now')" : "";
        await env.DB.prepare(
          `UPDATE instagram_leads SET status = ?${extraSet} WHERE id = ?`
        ).bind(status, leadId).run();

        return json({ success: true, id: leadId, status });
      } catch (err) {
        return json({ error: "Database fout: " + err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: GET /api/admin/settings — Instellingen ophalen
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/api/admin/settings") {
      if (!isAuthed(request)) return unauthorized();

      try {
        const { results } = await env.DB.prepare(
          `SELECT key, value FROM worker_settings`
        ).all();
        const data: Record<string, string> = {};
        for (const row of results) data[row.key] = row.value;
        return json(data);
      } catch (e) {
        return json({});
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /api/admin/settings — Instellingen opslaan
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/admin/settings") {
      if (!isAuthed(request)) return unauthorized();

      try {
        const body = await request.json();
        for (const [key, value] of Object.entries(body)) {
          await setSetting(key, value);
        }
        return json({ success: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /api/admin/telegram/test — Telegram debug test
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/admin/telegram/test") {
      if (!isAuthed(request)) return unauthorized();

      const debug: Record<string, any> = {
        bot_token_aanwezig: !!env.TELEGRAM_BOT_TOKEN,
        bot_token_preview: env.TELEGRAM_BOT_TOKEN
          ? `${String(env.TELEGRAM_BOT_TOKEN).substring(0, 12)}...`
          : "❌ NIET INGESTELD",
        chat_id_waarde: env.TELEGRAM_CHAT_ID || "❌ NIET INGESTELD",
        chat_id_type: !env.TELEGRAM_CHAT_ID
          ? "niet ingesteld"
          : String(env.TELEGRAM_CHAT_ID).startsWith("-")
          ? "✅ Groep/supergroep (negatief getal)"
          : "⚠️ Persoonlijk chat (positief getal)",
        stappen: [],
      };

      // Stap 1: getMe
      try {
        const getMeRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
        const getMeData = await getMeRes.json();
        if (getMeData.ok) {
          debug.stappen.push({ stap: "1. getMe", status: "✅ OK", bot_naam: getMeData.result.first_name, bot_username: "@" + getMeData.result.username });
        } else {
          debug.stappen.push({ stap: "1. getMe", status: "❌ MISLUKT", fout: getMeData.description, oplossing: "Bot token ongeldig. Maak nieuwe bot via @BotFather." });
          return json({ success: false, debug }, 400);
        }
      } catch (e: any) {
        debug.stappen.push({ stap: "1. getMe", status: "❌ NETWERK FOUT", fout: e.message });
        return json({ success: false, debug }, 500);
      }

      // Stap 2: getChat
      try {
        const getChatRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID }),
        });
        const getChatData = await getChatRes.json();
        if (getChatData.ok) {
          debug.stappen.push({ stap: "2. getChat", status: "✅ OK", chat_naam: getChatData.result.title || getChatData.result.first_name, chat_type: getChatData.result.type });
        } else {
          debug.stappen.push({ stap: "2. getChat", status: "❌ MISLUKT", fout: getChatData.description, oplossing: getChatData.description?.includes("chat not found") ? "Chat ID klopt niet of bot zit niet in de groep." : "Controleer TELEGRAM_CHAT_ID." });
          return json({ success: false, debug }, 400);
        }
      } catch (e: any) {
        debug.stappen.push({ stap: "2. getChat", status: "❌ NETWERK FOUT", fout: e.message });
      }

      // Stap 3: sendMessage met knop
      try {
        const sendData = await stuurTelegramMetKnop(
          `🧪 *Spectux Dashboard — Telegram Test*\n\n` +
          `✅ Verbinding werkt correct!\n` +
          `🕐 ${new Date().toLocaleString("nl-NL")}\n\n` +
          `Druk de knop hieronder om de inline knop te testen.`,
          "test-knop-id"
        );

        if (sendData.ok) {
          debug.stappen.push({ stap: "3. sendMessage met inline knop", status: "✅ BERICHT VERZONDEN", message_id: sendData.result.message_id });
          return json({ success: true, debug });
        } else {
          debug.stappen.push({ stap: "3. sendMessage", status: "❌ MISLUKT", fout: sendData.description, oplossing: sendData.description?.includes("bot was kicked") ? "Bot is uit groep verwijderd." : sendData.description?.includes("have no rights") ? "Bot heeft geen schrijfrechten." : "Onbekende fout." });
          return json({ success: false, debug }, 400);
        }
      } catch (e: any) {
        debug.stappen.push({ stap: "3. sendMessage", status: "❌ NETWERK FOUT", fout: e.message });
        return json({ success: false, debug }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: POST /api/admin/telegram/setup-webhook — Telegram webhook instellen
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/admin/telegram/setup-webhook") {
      if (!isAuthed(request)) return unauthorized();

      const webhookUrl = `${workerUrl}/webhook/telegram`;

      try {
        const res = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              allowed_updates: ["callback_query", "message"],
            }),
          }
        );
        const data = await res.json();
        return json({ success: data.ok, webhook_url: webhookUrl, fout: data.description });
      } catch (e: any) {
        return json({ success: false, fout: e.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE: DELETE /api/admin/leads/cleanup — Handmatige cleanup (ALLE gecontacteerd)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "DELETE" && url.pathname === "/api/admin/leads/cleanup") {
      if (!isAuthed(request)) return unauthorized();
      const verwijderd = await runManualCleanup();
      return json({ success: true, verwijderd_leads: verwijderd });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
