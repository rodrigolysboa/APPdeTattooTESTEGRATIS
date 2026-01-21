import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-User-Phone, X-Device-Id");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  // healthcheck
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "API online. Use POST em /api/generate" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // =========================
    // IDENTIFICA (Telefone + Device)
    // =========================
    const phoneRaw = req.headers["x-user-phone"];
    const deviceRaw = req.headers["x-device-id"];

    const phone = typeof phoneRaw === "string" ? phoneRaw.replace(/\D/g, "") : "";
    const deviceId = typeof deviceRaw === "string" ? deviceRaw.trim() : "";

    if (!(phone.startsWith("55") && phone.length >= 12 && phone.length <= 13)) {
      return res.status(401).json({ error: "Missing or invalid phone" });
    }
    if (!deviceId || deviceId.length < 8) {
      return res.status(401).json({ error: "Missing or invalid device id" });
    }

    const TRIAL_LIMIT = 5;
    const MAX_DEVICES = 3;

    const usedKey = `trial:used:${phone}`;
    const devicesKey = `trial:devicesjson:${phone}`;
    const leadKey = `lead:${phone}`;

    // =========================
    // CONTROLE DE DEVICES (JSON) — max 3
    // =========================
    const devicesJson = (await kv.get(devicesKey)) || "[]";
    let devices;
    try { devices = Array.isArray(devicesJson) ? devicesJson : JSON.parse(devicesJson); }
    catch { devices = []; }

    if (!Array.isArray(devices)) devices = [];

    const has = devices.includes(deviceId);
    if (!has) {
      if (devices.length >= MAX_DEVICES) {
        return res.status(429).json({
          error: "Device limit reached",
          code: "DEVICE_LIMIT",
          devices: MAX_DEVICES
        });
      }
      devices.push(deviceId);
      await kv.set(devicesKey, JSON.stringify(devices));
      await kv.expire(devicesKey, 60 * 60 * 24 * 180); // 180 dias
    }

    // =========================
    // CONTROLE: 5 testes por telefone
    // =========================
    const used = await kv.incr(usedKey);
    if (used === 1) {
      await kv.expire(usedKey, 60 * 60 * 24 * 180);

      // salva lead no primeiro uso
      await kv.set(leadKey, JSON.stringify({ phone, first_seen: Date.now(), last_seen: Date.now() }));
      await kv.expire(leadKey, 60 * 60 * 24 * 365);
    } else {
      // atualiza last_seen
      const leadJson = (await kv.get(leadKey)) || "{}";
      let lead;
      try { lead = typeof leadJson === "string" ? JSON.parse(leadJson) : (leadJson || {}); }
      catch { lead = {}; }
      lead.phone = phone;
      lead.last_seen = Date.now();
      await kv.set(leadKey, JSON.stringify(lead));
      await kv.expire(leadKey, 60 * 60 * 24 * 365);
    }

    if (used > TRIAL_LIMIT) {
      return res.status(429).json({
        error: "Trial limit reached",
        code: "TRIAL_LIMIT",
        used: TRIAL_LIMIT,
        limit: TRIAL_LIMIT
      });
    }

    // =========================
    // GERAÇÃO (igual seu projeto)
    // =========================
    const { imageBase64, style = "clean", mimeType = "image/jpeg", prompt = "" } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

    const MAX_BASE64_LEN = 4_500_000;
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_BASE64_LEN) {
      return res.status(413).json({ error: "Image payload too large. Compress and try again." });
    }

    const allowedStyles = new Set(["line", "shadow", "clean"]);
    const safeStyle = allowedStyles.has(style) ? style : "clean";

    const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
    const safeMime = allowedMime.has(mimeType) ? mimeType : "image/jpeg";

    const userNote =
      typeof prompt === "string" && prompt.trim().length
        ? `\n\nOBSERVAÇÕES DO TATUADOR (use apenas se fizer sentido): ${prompt.trim()}`
        : "";

    const prompts = {
      line: `
OBJETIVO (MODO LINE / DECALQUE DE LINHAS):
Você receberá uma FOTO de uma tatuagem aplicada na PELE.
Sua tarefa é IDENTIFICAR e RECRIAR a MESMA ARTE como LINE ART em uma FOLHA A4 BRANCA, vista de cima.

REGRAS:
- APENAS linhas pretas (sem sombras, sem cinza, sem textura, sem pele).
- Corrigir perspectiva/curvatura e deixar plano em papel.
- Completar partes faltantes SEM inventar elementos novos.
- Se houver texto/lettering, reescrever fielmente.

SAÍDA:
- Fundo branco puro, estilo folha A4, sem objetos, sem UI.
`,
      shadow: `
OBJETIVO (MODO SHADOW / LINHAS + SOMBRA LEVE):
Transformar foto de tattoo em desenho em folha A4 branca.
- Prioridade máxima: linhas.
- Permitir sombra LEVE e CONTROLADA, sem textura de pele.
- Completar partes faltantes sem inventar.
- Lettering fiel se existir.
- Folha A4 branca vista de cima, mesa de madeira clara discreta.
`,
      clean: `
OBJETIVO (MODO CLEAN / TATUAGEM → DESENHO IDÊNTICO):
Transformar a tatuagem da foto no MESMO desenho, corrigindo apenas deformação do corpo.
- Visualmente igual à tattoo original.
- Não estilizar, não simplificar, não “embelezar”.
- Completar partes faltantes sem inventar.
- Folha A4 branca realista, vista de cima, fundo limpo.
`
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
      apiKey;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: (prompts[safeStyle] || prompts.clean) + userNote + "\n\nIMPORTANTE: Gere SOMENTE a imagem final. Não retorne texto."
            },
            {
              inlineData: { mimeType: safeMime, data: imageBase64 }
            }
          ]
        }
      ]
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timer);

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: json?.error?.message || "Gemini API error",
        raw: json
      });
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) return res.status(500).json({ error: "No image returned", raw: json });

    return res.status(200).json({
      imageBase64: inline,
      trial: { used, limit: TRIAL_LIMIT }
    });
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Timeout generating image" : (err?.message || "Unexpected error");
    return res.status(500).json({ error: msg });
  }
}
