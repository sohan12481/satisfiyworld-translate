// SatisfiyWorld Backend Translation API (Vercel serverless - CommonJS, robust)
const DEFAULT_TIMEOUT = 10000; // 10s
const MAX_BODY_LENGTH = 20000; // safety limit for text length
const MAX_RETRIES = 2;

module.exports = async (req, res) => {
  // Basic CORS (adjust origin in production as needed)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    // Get params for GET or POST
    let text, to = "en";

    if (req.method === "GET") {
      text = req.query?.text;
      to = req.query?.to || to;
    } else {
      // POST: try req.body first (Next.js may have parsed it), otherwise parse raw
      let body = req.body;
      if (!body) {
        body = await new Promise((resolve) => {
          let data = "";
          req.on && req.on("data", (chunk) => (data += chunk));
          req.on && req.on("end", () => {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (e) {
              resolve({});
            }
          });
        });
      }
      text = body?.text || body?.q;
      to = body?.to || to;
    }

    if (!text) {
      return res.status(400).json({ success: false, error: "Missing 'text' parameter" });
    }
    if (typeof text === "string" && text.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ success: false, error: `Text too long (max ${MAX_BODY_LENGTH} chars)` });
    }

    // Ensure global fetch exists (Vercel uses Node 18+ which has fetch)
    if (typeof fetch === "undefined") {
      return res.status(500).json({
        success: false,
        error: "Server misconfiguration: global fetch not available. Use Node 18+ or install node-fetch."
      });
    }

    // Fetch with timeout and simple retry
    let attempt = 0;
    let lastError = null;
    while (attempt < MAX_RETRIES) {
      attempt++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      try {
        const response = await fetch("https://translate.argosopentech.com/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: text, source: "auto", target: to, format: "text" }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          lastError = new Error("Upstream response status: " + response.status);
          // retry for transient 5xx
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 300 * attempt));
            continue;
          } else {
            const textBody = await response.text().catch(()=>"");
            return res.status(502).json({ success: false, error: "Bad upstream response", status: response.status, body: textBody });
          }
        }

        const data = await response.json().catch(() => null);

        // Best-effort extraction of translated text (handles a few possible shapes)
        const translatedText =
          (data && (data.translatedText || data.translation || data.result)) ||
          (Array.isArray(data) && data[0] && data[0].translatedText) ||
          (data && data.translations && data.translations[0] && data.translations[0].text) ||
          null;

        if (translatedText == null) {
          // Return raw data too so caller or logs can inspect
          return res.status(200).json({ success: true, originalText: text, translatedText: null, targetLanguage: to, api: "Satisfiyworld-Translate", raw: data });
        }

        return res.status(200).json({ success: true, originalText: text, translatedText, targetLanguage: to, api: "Satisfiyworld-Translate", raw: data });
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        // if abort/timeouts or network errors, retry a bit
        if ((err.name === "AbortError" || err.code === "ECONNRESET" || err.code === "ENOTFOUND") && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 300 * attempt));
          continue;
        }
        // otherwise break and return error
        break;
      }
    }

    // If we exit loop without success
    return res.status(504).json({ success: false, error: "Upstream request failed", details: lastError?.message });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Server error", details: err?.message });
  }
};
