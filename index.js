export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS Headers voor je React Dashboard
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 1: APIFY WEBHOOK (Ontvangt nieuwe leads)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/webhook/apify") {
      try {
        const apifyData = await request.json();
        const leads = apifyData.items || [];

        for (const lead of leads) {
          // 1. Skip als er al een website is
          if (lead.externalUrl && lead.externalUrl !== "") continue;

          // 2. Check in D1 of we deze lead al hebben
          const existing = await env.DB.prepare("SELECT id FROM instagram_leads WHERE username = ?")
            .bind(lead.username).first();
          
          if (existing) continue; // Al bekend, overslaan

          // 3. Vraag Gemini om een DM te schrijven
          const geminiPrompt = `Je bent eigenaar van Spectux webdesign. Schrijf een korte, informele Instagram DM naar een startende ondernemer met deze bio: "${lead.biography}". Feliciteer ze en vraag casual of ze al aan een website werken. Max 3 zinnen in het Nederlands.`;
          
          const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: geminiPrompt }] }] })
          });
          
          const geminiData = await geminiResponse.json();
          const dmTekst = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Hoi! Gefeliciteerd met je start. Heb je toevallig al nagedacht over een website?";

          // 4. Sla op in D1
          const leadId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO instagram_leads (id, username, full_name, biography, ai_message) VALUES (?, ?, ?, ?, ?)"
          ).bind(leadId, lead.username, lead.fullName || '', lead.biography || '', dmTekst).run();

          // 5. Notificatie naar Telegram
          const telegramBericht = `🚀 *Nieuwe Lead: ${lead.username}*\n\n📝 Bio: ${lead.biography}\n\n💬 *Bericht:*\n\`${dmTekst}\``;
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: telegramBericht, parse_mode: 'Markdown' })
          });
        }
        return new Response("Verwerkt", { status: 200, headers: corsHeaders });
      } catch (err) {
        return new Response("Error: " + err.message, { status: 500, headers: corsHeaders });
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 2: DASHBOARD API (Leads ophalen)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/api/admin/leads") {
      // Simpele beveiliging: check je admin password
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) return new Response("Unauthorized", { status: 401 });

      const { results } = await env.DB.prepare("SELECT * FROM instagram_leads ORDER BY created_at DESC").all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ROUTE 3: DASHBOARD API (Status updaten, bijv. 'gecontacteerd')
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/leads/")) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) return new Response("Unauthorized", { status: 401 });

      const leadId = url.pathname.split("/").pop();
      const { status } = await request.json();

      await env.DB.prepare("UPDATE instagram_leads SET status = ? WHERE id = ?").bind(status, leadId).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
