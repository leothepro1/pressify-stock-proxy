import express from "express";
import fetch from "node-fetch";
import { Readable } from "stream";
import { pipeline } from "stream";
import { promisify } from "util";

const app = express();
const PORT = process.env.PORT || 3000;
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const pump = promisify(pipeline);

/* ---------------------------
   Helpers
----------------------------*/
function pickFilenameFromUrl(u) {
  const last = u.pathname.split("/").pop() || "image";
  return last.includes(".") ? last : `${last}.jpg`;
}

async function maybeLoadSharp() {
  try {
    // Dynamisk import så appen funkar även utan sharp installerat
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

// ⇨ NEW: enkel språkdetektor från Accept-Language -> Pexels-locale
function preferredLocale(req) {
  const h = String(req.headers["accept-language"] || "").toLowerCase();
  // plocka första taggen, t.ex. "sv-SE,sv;q=0.9,en;q=0.8" -> "sv-se"
  const primary = h.split(",")[0]?.trim();
  if (!primary) return "sv-SE";
  // mappa några vanliga
  if (primary.startsWith("sv")) return "sv-SE";
  if (primary.startsWith("en")) return "en-US";
  if (primary.startsWith("de")) return "de-DE";
  if (primary.startsWith("fr")) return "fr-FR";
  if (primary.startsWith("es")) return "es-ES";
  if (primary.startsWith("it")) return "it-IT";
  if (primary.startsWith("pt")) return "pt-BR";
  if (primary.startsWith("nl")) return "nl-NL";
  // fallback
  return "sv-SE";
}

/* ---------------------------
   Normalisering från Pexels
----------------------------*/
function normalizePexels(photo) {
  return {
    id: `prov:pexels:${photo.id}`,
    source: "pexels",
    type: "photo",

    url: photo.url,
    author: photo.photographer,
    author_url: photo.photographer_url,
    photographer_id: photo.photographer_id,
    alt: photo.alt || "",
    author_avatar_url: null,

    // Lägg till alla relevanta storlekar
    tiny: photo.src?.tiny,
    small: photo.src?.small,
    medium: photo.src?.medium,    // ~350w
    large: photo.src?.large,      // ~940w
    large2x: photo.src?.large2x,  // ~1880w

    // Behåll befintliga fält
    thumb: photo.src?.large || photo.src?.medium, // bättre default
    full: photo.src?.original,
    width: photo.width,
    height: photo.height,
    orientation:
      photo.width > photo.height ? "landscape" :
      photo.width < photo.height ? "portrait" : "square",

    attribution_required: false,

    download_token: Buffer.from(JSON.stringify({
      src: "pexels",
      download_url: photo.src?.original,
      width: photo.width,
      height: photo.height
    })).toString("base64"),
  };
}


/* ---------------------------
   /search – sök & curated
----------------------------*/
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const per_page = Math.min(80, Math.max(1, Number(req.query.per_page || 48)));

    const orientation = (req.query.orientation || "").trim();
    const color = (req.query.color || "").trim();
    const size = (req.query.size || "").trim();

    // ⇨ NEW: läs locale från query ELLER från Accept-Language (fallback sv-SE)
    const locale = (req.query.locale ? String(req.query.locale) : preferredLocale(req));

 const isTrending = !q || q.toLowerCase() === "trending";
    const filtersOn = !!(orientation || color || size);
    const forceSearch = isTrending && filtersOn;
    const base = forceSearch
      ? "https://api.pexels.com/v1/search"
      : (isTrending ? "https://api.pexels.com/v1/curated" : "https://api.pexels.com/v1/search");

    const url = new URL(base);
    if (base.includes("/search")) {
      const effectiveQuery = !isTrending ? q : "popular";
      url.searchParams.set("query", effectiveQuery);
    }
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(per_page));
    if (orientation) url.searchParams.set("orientation", orientation);
    if (color) url.searchParams.set("color", color);
    if (size) url.searchParams.set("size", size);
    if (locale) url.searchParams.set("locale", locale); // ⇨ NEW

    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: "pexels_error" });
    const j = await r.json();

    const results = (j.photos || []).map(normalizePexels);

    let has_more = false;
    if (typeof j.total_results === "number") {
      has_more = page * per_page < j.total_results;
    } else if (j.next_page) {
      has_more = true;
    }

    if (page === 1) {
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
    } else {
      res.set("Cache-Control", "no-store");
    }

    // ⇨ NEW: returnera även total_results + locale för klientdebug
    res.json({
      results,
      page,
      per_page,
      total: j.total_results,           // befintligt
      total_results: j.total_results,   // nytt alias om du vill läsa detta i klient
      has_more,
      locale                             // trevligt att se vad som används
    });
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

/* -------------------------------------------
   /download – original eller resize (w/h)
--------------------------------------------*/
app.get("/download", async (req, res) => {
  try {
    const raw = String(req.query.token || "");
    if (!raw) return res.status(400).json({ error: "bad_token" });

    let payload;
    try {
      payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      return res.status(400).json({ error: "bad_token" });
    }

    const fileUrlStr = payload?.download_url;
    if (!fileUrlStr) return res.status(400).json({ error: "bad_token" });

    const wantW = req.query.w ? Math.max(1, parseInt(String(req.query.w), 10)) : null;
    const wantH = req.query.h ? Math.max(1, parseInt(String(req.query.h), 10)) : null;

    // Hämta original från Pexels
    const upstream = await fetch(fileUrlStr);
    if (!upstream.ok) return res.status(upstream.status).json({ error: "upstream_error" });

    const u = new URL(fileUrlStr);
    const baseName = pickFilenameFromUrl(u);

    // Om ingen resize önskas -> streama original som attachment
    if (!wantW && !wantH) {
      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      const cl = upstream.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Content-Disposition", `attachment; filename="${baseName}"`);
      res.setHeader("Cache-Control", "private, max-age=0");

      const nodeStream =
        typeof upstream.body?.getReader === "function"
          ? Readable.fromWeb(upstream.body)
          : upstream.body;

      await pump(nodeStream, res);
      return;
    }

    // Resize begärd -> försök med sharp
    const Sharp = await maybeLoadSharp();
    if (!Sharp) {
      // Fallback: saknas sharp -> ge originalet (hellre ladda ner än fel)
      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      const cl = upstream.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Content-Disposition", `attachment; filename="${baseName}"`);
      res.setHeader("Cache-Control", "private, max-age=0");

      const nodeStream =
        typeof upstream.body?.getReader === "function"
          ? Readable.fromWeb(upstream.body)
          : upstream.body;

      await pump(nodeStream, res);
      return;
    }

    // Läs in originalet i buffer (krävs för sharp)
    const origBuf = Buffer.from(await upstream.arrayBuffer());

    // Bygg filnamn, ex: pexels-photo-xxxx_640x426.jpg
    const suffix =
      (wantW || "") + (wantW && wantH ? "x" : "") + (wantH || "");
    const outName = suffix
      ? baseName.replace(/(\.[a-z0-9]+)$/i, `_${suffix}$1`)
      : baseName;

    // Kör resize (cover = fyller exakt W x H, beskär vid behov)
    let inst = Sharp(origBuf);
    if (wantW && wantH) inst = inst.resize(wantW, wantH, { fit: "cover" });
    else if (wantW)     inst = inst.resize(wantW, null, { fit: "inside" });
    else if (wantH)     inst = inst.resize(null, wantH, { fit: "inside" });

    const ctOut = "image/jpeg";
    res.setHeader("Content-Type", ctOut);
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    res.setHeader("Cache-Control", "private, max-age=0");

    // Streama sharp-output
    const outStream = inst.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: false })
      .then(b => Readable.from(b));

    await pump(await outStream, res);
  } catch {
    if (!res.headersSent) res.status(400).json({ error: "bad_token" });
    else try { res.end(); } catch {}
  }
});

/* ---------------------------
   Healthcheck
----------------------------*/
app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`pressify-stock-proxy listening on ${PORT}`);
});

