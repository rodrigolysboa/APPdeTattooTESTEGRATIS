import { createClient } from "@vercel/kv";

// ✅ IMPORTANTÍSSIMO: Next tem limite baixo de body.
// Isso evita erro de payload grande quando manda base64.
export const config = {
  api: { bodyParser: { sizeLimit: "6mb" } }
};

// ✅ Usa STORAGE_ se existir (seu caso), senão cai no padrão KV_
const kv = createClient({
  url: process.env.STORAGE_KV_REST_API_URL || process.env.KV_REST_API_URL,
  token: process.env.STORAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-User-Phone, X-Device-Id"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET")
    return res
      .status(200)
      .json({ ok: true, message: "API online. Use POST em /api/generate" });

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // =========================
    // ✅ IDENTIFICA (Telefone + Device)
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

    // =========================
    // ✅ LIMITES
    // =========================
    const TRIAL_LIMIT = 15;
    const DEVICES_LIMIT = 3;
    const PER_HOUR_LIMIT = 40;

    const devicesKey = `trial:devices:${phone}`;
    const usedKey = `trial:used:${phone}`;
    const leadKey = `lead:${phone}`;

    // ✅ 40 por hora (anti-bot)
    const hourKey = `rl:${phone}:${Math.floor(Date.now() / 3600000)}`;
    const hourCount = await kv.incr(hourKey);
    if (hourCount === 1) await kv.expire(hourKey, 60 * 60); // 1h
    if (hourCount > PER_HOUR_LIMIT) {
      return res.status(429).json({
        error: "Hourly limit reached",
        code: "HOURLY_LIMIT",
        used: PER_HOUR_LIMIT,
        limit: PER_HOUR_LIMIT
      });
    }

    // ✅ Limite 3 devices (bloqueia 4º)
    const isKnown = await kv.sismember(devicesKey, deviceId);
    const deviceCount = await kv.scard(devicesKey);

    if (!isKnown && deviceCount >= DEVICES_LIMIT) {
      return res.status(403).json({
        error: "Device limit reached",
        code: "DEVICE_LIMIT",
        limit: DEVICES_LIMIT
      });
    }

    // registra device
    await kv.sadd(devicesKey, deviceId);
    await kv.expire(devicesKey, 60 * 60 * 24 * 180); // 180 dias

    // ✅ 15 testes por telefone
    const used = await kv.incr(usedKey);
    if (used === 1) {
      await kv.expire(usedKey, 60 * 60 * 24 * 180);
      await kv.hset(leadKey, { phone, first_seen: String(Date.now()) });
      await kv.expire(leadKey, 60 * 60 * 24 * 365);
    } else {
      await kv.hset(leadKey, { last_seen: String(Date.now()) });
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
    // ✅ GERAÇÃO (mesma qualidade)
    // =========================
    const { imageBase64, style = "clean", mimeType = "image/jpeg", prompt = "" } =
      req.body || {};

    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

    // proteção básica
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
Recriar a tatuagem como LINE ART em uma folha A4 branca (vista de cima).
- Apenas linhas pretas (sem sombras/cinza/textura/pele).
- Corrigir perspectiva/curvatura e deixar plano em papel.
- Completar partes faltantes SEM inventar elementos novos.
- Lettering fiel se existir.
SAÍDA: folha A4 branca, sem UI, sem objetos extras.
`,
      shadow: `
OBJETIVO (MODO SHADOW / LINHAS + SOMBRA LEVE):
Recriar em A4 branca com linhas priorizadas e sombra leve controlada.
- Sem textura de pele, sem sujeira.
- Completar partes faltantes sem inventar.
- Lettering fiel se existir.
SAÍDA: folha A4 vista de cima, mesa de madeira clara bem discreta.
`,
      clean: `
OBJETIVO (MODO CLEAN / TATUAGEM → DESENHO IDÊNTICO):
Transformar a tattoo aplicada na pele em desenho em A4 branca,
mantendo o MESMO visual da tatuagem (linhas/sombras/luzes/peso de preto).
- Corrigir curvatura/perspectiva SEM alterar a arte.
- Completar partes faltantes por continuidade real (SEM inventar).
- Lettering idêntico se existir.
SAÍDA: folha A4 branca realista vista de cima, fundo limpo, sem UI/watermark.
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
              text:
                (prompts[safeStyle] || prompts.clean) +
                userNote +
                "\n\nIMPORTANTE: Gere SOMENTE a imagem final. Não retorne texto."
            },
            { inlineData: { mimeType: safeMime, data: imageBase64 } }
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
      trial: { used, limit: TRIAL_LIMIT },
      hourly: { used: hourCount, limit: PER_HOUR_LIMIT }
    });
  } catch (err) {
    const msg =
      err?.name === "AbortError" ? "Timeout generating image" : err?.message || "Unexpected error";
    return res.status(500).json({ error: msg });
  }
}
