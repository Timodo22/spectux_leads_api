/**
 * Spectux Leads Worker
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
 * ── TELEGRAM CHAT ID UITLEG ──────────────────────────────────────────────────
 *   Persoonlijk:   positief getal  → 123456789
 *   Groep/groepsapp: NEGATIEF getal → -123456789
 *   Supergroep:    negatief lang   → -1001234567890
 *   Geen #. Gebruik @userinfobot in je groep om het ID te vinden.
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

    // ── AUTO CLEANUP: verwijder leads ouder dan 2 dagen na contact ────────────
    const runCleanup = async () => {
      try {
        const result = await env.DB.prepare(`
          DELETE FROM instagram_leads
          WHERE status = 'gecontacteerd'
            AND contacted_at IS NOT NULL
            AND contacted_at < datetime('now', '-2 days')
        `).run();
        return result.changes || 0;
      } catch (e) {
        console.error("Cleanup fout:", e);
        return 0;
      }
    };

    // ── TELEGRAM HELPER ───────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 1: POST /webhook/apify — Nieuwe leads ontvangen
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/webhook/apify") {
      try {
        const apifyData = await request.json();
        const leads = apifyData.items || [];
        let nieuwCount = 0;

        for (const lead of leads) {
          if (lead.externalUrl && lead.externalUrl !== "") continue;

          const existing = await env.DB.prepare(
            "SELECT id FROM instagram_leads WHERE username = ?"
          ).bind(lead.username).first();
          if (existing) continue;

          let dmTekst =
            "Hoi! Gefeliciteerd met je start. Heb je toevallig al nagedacht over een website?";

          try {
            const geminiResponse = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{
                    parts: [{
                      text: `Je bent eigenaar van Spectux webdesign. Schrijf een korte, informele Instagram DM naar een startende ondernemer met deze bio: "${lead.biography}". Feliciteer ze en vraag casual of ze al aan een website werken. Max 3 zinnen in het Nederlands.`,
                    }],
                  }],
                }),
              }
            );
            const geminiData = await geminiResponse.json();
            dmTekst = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || dmTekst;
          } catch (e) {
            console.error("Gemini fout:", e);
          }

          const leadId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO instagram_leads (id, username, full_name, biography, ai_message, status)
             VALUES (?, ?, ?, ?, ?, 'nieuw')`
          ).bind(leadId, lead.username, lead.fullName || "", lead.biography || "", dmTekst).run();

          nieuwCount++;

          try {
            await stuurTelegram(
              `🚀 *Nieuwe Lead: @${lead.username}*\n\n` +
              `📝 *Bio:* ${lead.biography}\n\n` +
              `💬 *Stuur dit DM:*\n\`${dmTekst}\`\n\n` +
              `👉 Markeer als verzonden in het dashboard na contact.`
            );
          } catch (e) {
            console.error("Telegram fout:", e);
          }
        }

        return json({ success: true, nieuw: nieuwCount });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 2: GET /api/admin/leads — Leads ophalen
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/api/admin/leads") {
      if (!isAuthed(request)) return unauthorized();

      // Cleanup op de achtergrond
      ctx.waitUntil(runCleanup());

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
        } catch (e) {
          // admin_stats tabel bestaat nog niet — voer de migratie uit
        }

        return json({ leads: results, total_contacted: totalContacted });
      } catch (err) {
        return json({ error: "Database fout: " + err.message }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 3: POST /api/admin/leads/:id/contacted — DM gestuurd knop
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

        // Zet status op gecontacteerd + sla tijdstip op (voor 2-daagse cleanup)
        await env.DB.prepare(
          `UPDATE instagram_leads
           SET status = 'gecontacteerd', contacted_at = datetime('now')
           WHERE id = ?`
        ).bind(leadId).run();

        // +1 globale contact counter
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
        } catch (e) {
          console.error("Counter fout (migratie nodig?):", e);
        }

        // Telegram bevestiging
        try {
          await stuurTelegram(
            `✅ *DM Verstuurd naar @${lead.username}*\n\n` +
            `📨 Bericht: \`${lead.ai_message}\`\n\n` +
            `🗑️ Lead wordt in 2 dagen automatisch verwijderd.\n` +
            `📊 Totaal gecontacteerd: *${newCount}*`
          );
        } catch (e) {
          console.error("Telegram fout:", e);
        }

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
    // ROUTE 4: PATCH /api/admin/leads/:id — Status dropdown update
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
    // ROUTE 5: POST /api/admin/telegram/test — Telegram debug test
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/admin/telegram/test") {
      if (!isAuthed(request)) return unauthorized();

      const debug = {
        bot_token_aanwezig: !!env.TELEGRAM_BOT_TOKEN,
        bot_token_preview: env.TELEGRAM_BOT_TOKEN
          ? `${String(env.TELEGRAM_BOT_TOKEN).substring(0, 12)}...`
          : "❌ NIET INGESTELD",
        chat_id_waarde: env.TELEGRAM_CHAT_ID || "❌ NIET INGESTELD",
        chat_id_type: !env.TELEGRAM_CHAT_ID
          ? "niet ingesteld"
          : String(env.TELEGRAM_CHAT_ID).startsWith("-")
          ? "✅ Groep/supergroep (negatief getal — correct)"
          : "⚠️ Persoonlijk chat (positief getal)",
        stappen: [],
      };

      // Stap 1: getMe
      try {
        const getMeRes = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`
        );
        const getMeData = await getMeRes.json();
        if (getMeData.ok) {
          debug.stappen.push({
            stap: "1. getMe (bot token geldig?)",
            status: "✅ OK",
            bot_naam: getMeData.result.first_name,
            bot_username: "@" + getMeData.result.username,
          });
        } else {
          debug.stappen.push({
            stap: "1. getMe (bot token geldig?)",
            status: "❌ MISLUKT",
            fout: getMeData.description,
            oplossing: "Bot token is ongeldig. Maak een nieuwe bot via @BotFather.",
          });
          return json({ success: false, debug }, 400);
        }
      } catch (e) {
        debug.stappen.push({ stap: "1. getMe", status: "❌ NETWERK FOUT", fout: e.message });
        return json({ success: false, debug }, 500);
      }

      // Stap 2: getChat
      try {
        const getChatRes = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID }),
          }
        );
        const getChatData = await getChatRes.json();
        if (getChatData.ok) {
          debug.stappen.push({
            stap: "2. getChat (chat ID geldig?)",
            status: "✅ OK",
            chat_naam: getChatData.result.title || getChatData.result.first_name,
            chat_type: getChatData.result.type,
          });
        } else {
          const isChatNotFound = getChatData.description?.includes("chat not found");
          debug.stappen.push({
            stap: "2. getChat (chat ID geldig?)",
            status: "❌ MISLUKT",
            fout: getChatData.description,
            oplossing: isChatNotFound
              ? "Chat ID klopt niet, of de bot zit nog niet in de groep. Voeg de bot toe en stuur een bericht in de groep."
              : "Controleer TELEGRAM_CHAT_ID in Cloudflare → Workers → Settings → Variables.",
          });
          return json({ success: false, debug }, 400);
        }
      } catch (e) {
        debug.stappen.push({ stap: "2. getChat", status: "❌ NETWERK FOUT", fout: e.message });
      }

      // Stap 3: sendMessage
      try {
        const sendData = await stuurTelegram(
          `🧪 *Spectux Dashboard — Telegram Test*\n\n` +
          `✅ Verbinding werkt correct!\n` +
          `🕐 ${new Date().toLocaleString("nl-NL")}\n\n` +
          `Als je dit bericht ziet is alles goed ingesteld.`
        );

        if (sendData.ok) {
          debug.stappen.push({
            stap: "3. sendMessage (bericht versturen)",
            status: "✅ BERICHT VERZONDEN",
            message_id: sendData.result.message_id,
          });
          return json({ success: true, debug });
        } else {
          const gekicked = sendData.description?.includes("bot was kicked");
          const geenRechten = sendData.description?.includes("have no rights");
          debug.stappen.push({
            stap: "3. sendMessage",
            status: "❌ MISLUKT",
            fout: sendData.description,
            oplossing: gekicked
              ? "Bot is uit de groep verwijderd. Voeg hem opnieuw toe."
              : geenRechten
              ? "Bot heeft geen berichtrechten. Ga naar groepsinstellingen → Beheerders → geef de bot schrijfrechten."
              : "Onbekende fout.",
          });
          return json({ success: false, debug }, 400);
        }
      } catch (e) {
        debug.stappen.push({ stap: "3. sendMessage", status: "❌ NETWERK FOUT", fout: e.message });
        return json({ success: false, debug }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 6: DELETE /api/admin/leads/cleanup — Handmatige cleanup
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "DELETE" && url.pathname === "/api/admin/leads/cleanup") {
      if (!isAuthed(request)) return unauthorized();
      const verwijderd = await runCleanup();
      return json({ success: true, verwijderd_leads: verwijderd });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
