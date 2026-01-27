import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Device-Id, X-User-Id"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  // healthcheck
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, message: "API online. Use POST em /api/generate" });
  }

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    // =========================
    // IDENTIFICA (UserId opcional + Device obrigatório)
    // =========================
    const deviceRaw = req.headers["x-device-id"];
    const deviceId = typeof deviceRaw === "string" ? deviceRaw.trim() : "";

    // ✅ NOVO: conta (para travar em todos os dispositivos)
    const userRaw = req.headers["x-user-id"];
    const userId =
      typeof userRaw === "string" ? userRaw.trim().slice(0, 128) : "";

    if (!deviceId || deviceId.length < 8) {
      return res.status(401).json({ error: "Missing or invalid device id" });
    }

    // =========================
    // LIMITES DO TESTE
    // =========================
    const TRIAL_LIMIT = 7; // 7 gerações
    const WINDOW_HOURS = 25; // a cada 25h libera mais 7
    const WINDOW_TTL = WINDOW_HOURS * 60 * 60; // em segundos

    // =========================
    // SELETOR DE CHAVE (por conta quando existir; senão por device)
    // =========================
    const scopeType = userId ? "user" : "device";
    const scopeId = userId || deviceId;

    // Keys (por user OU por device)
    const leadKey = `lead:${scopeType}:${scopeId}`;
    const winUsedKey = `trialwin:used:${scopeType}:${scopeId}`;
    const winStartKey = `trialwin:start:${scopeType}:${scopeId}`;

    // ✅ Opcional: registrar devices usados pela conta (para auditoria)
    // (não limita, só registra)
    if (userId) {
      const userDevicesKey = `userdevices:${userId}`;
      // sadd/smembers existem no @vercel/kv (Redis)
      await kv.sadd(userDevicesKey, deviceId);
      await kv.expire(userDevicesKey, 60 * 60 * 24 * 365);
    }

    // =========================
    // LEAD (mantém)
    // =========================
    const leadJson = (await kv.get(leadKey)) || "{}";
    let lead;
    try {
      lead =
        typeof leadJson === "string" ? JSON.parse(leadJson) : leadJson || {};
    } catch {
      lead = {};
    }

    if (!lead.first_seen) lead.first_seen = Date.now();
    lead.scopeType = scopeType;
    lead.scopeId = scopeId;
    lead.userId = userId || null;
    lead.deviceId = deviceId;
    lead.last_seen = Date.now();

    await kv.set(leadKey, JSON.stringify(lead));
    await kv.expire(leadKey, 60 * 60 * 24 * 365);

    // =========================
    // CONTROLE: 7 por 25h (janela com TTL)
    // Agora é POR CONTA quando userId existir.
    // =========================
    const usedInWindow = await kv.incr(winUsedKey);

    if (usedInWindow === 1) {
      await kv.expire(winUsedKey, WINDOW_TTL);
      await kv.set(winStartKey, String(Date.now()));
      await kv.expire(winStartKey, WINDOW_TTL);
    }

    if (usedInWindow > TRIAL_LIMIT) {
      return res.status(429).json({
        error: "Trial limit reached",
        code: "TRIAL_LIMIT",
        used: TRIAL_LIMIT,
        limit: TRIAL_LIMIT,
        scope: scopeType, // "user" ou "device"
      });
    }

    // =========================
    // GERAÇÃO (igual seu projeto)
    // =========================
    const { imageBase64, style = "clean", mimeType = "image/jpeg", prompt = "" } =
      req.body || {};
    if (!imageBase64)
      return res.status(400).json({ error: "imageBase64 is required" });

    const MAX_BASE64_LEN = 4_500_000;
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_BASE64_LEN) {
      return res
        .status(413)
        .json({ error: "Image payload too large. Compress and try again." });
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
OBJETIVO (MODO LINE / EXTRAÇÃO DE LINHAS PURAS):

Você receberá a imagem de uma tatuagem aplicada na pele humana.
Sua tarefa é extrair e reconstruir EXCLUSIVAMENTE os TRAÇOS ORIGINAIS do desenho, convertendo-os em LINE ART puro, preciso e alinhado.

PRINCÍPIO CENTRAL:
- Considere apenas os contornos reais do desenho.
- Ignore completamente a pele, sombras, cores, preenchimentos, texturas, luz, reflexos e qualquer efeito visual.
- O resultado deve ser um desenho técnico de linhas finas, pronto para decalque profissional.

REGRAS ABSOLUTAS (OBRIGATÓRIAS):
1. Usar SOMENTE linhas pretas finas (#000000).
2. Proibir qualquer sombra, cinza, degradê, pintura, preenchimento, pontilhismo, hachura ou espessamento de linha.
3. Não estilizar, não embelezar e não reinterpretar o desenho.
4. Não adicionar elementos inexistentes na tatuagem original.
5. Corrigir completamente distorções de perspectiva e curvatura do corpo, deixando o desenho plano, simétrico e alinhado.
6. Alinhar rigorosamente todas as linhas, principalmente em textos, letras e números.
7. Se houver lettering, corrigir inclinações, irregularidades e deformações, mantendo o estilo original.
8. Reconstruir partes ocultas apenas quando necessário, sem alterar o traço original.
9. Não preencher áreas internas: apenas contornos e linhas estruturais.

SAÍDA VISUAL:
- Fundo totalmente branco (#FFFFFF), uniforme, sem textura e sem aparência de papel.
- Nenhum objeto, sombra, moldura, interface ou elemento extra.
- Apenas o desenho em linhas pretas finas sobre o fundo branco.

RESULTADO FINAL:
- Decalque em line art puro, limpo, preciso e técnico.
- Aparência de desenho vetorial e stencil profissional.
- Linhas finas, contínuas, bem definidas e perfeitamente alinhadas.
- Nenhum elemento além das linhas do desenho.
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
`,
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
                "\n\nIMPORTANTE: Gere SOMENTE a imagem final. Não retorne texto.",
            },
            {
              inlineData: { mimeType: safeMime, data: imageBase64 },
            },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: json?.error?.message || "Gemini API error",
        raw: json,
      });
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) return res.status(500).json({ error: "No image returned", raw: json });

    return res.status(200).json({
      imageBase64: inline,
      trial: { used: usedInWindow, limit: TRIAL_LIMIT, scope: scopeType },
    });
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Timeout generating image"
        : err?.message || "Unexpected error";
    return res.status(500).json({ error: msg });
  }
}
