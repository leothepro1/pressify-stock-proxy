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
   Normalisering från Pexels
----------------------------*/
function normalizePexels(photo) {
  return {
    id: `prov:pexels:${photo.id}`,
    source: "pexels",
    thumb: photo.src?.medium,
    full: photo.src?.original,
    width: photo.width,
    height: photo.height,
    orientation:
      photo.width > photo.height
        ? "landscape"
        : photo.width < photo.height
        ? "portrait"
        : "square",
    type: "photo",
    author: photo.photographer,
    author_url: photo.photographer_url,
    attribution_required: false,
    // Token som frontenden kan ge till /download
    download_token: Buffer.from(
      JSON.stringify({
        src: "pexels",
        download_url: photo.src?.original,
      })
    ).toString("base64"),
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

    // Vidarebefordra extra filter (om klienten skickar dem)
    const orientation = (req.query.orientation || "").trim(); // 'landscape'|'portrait'|'square'
    const color = (req.query.color || "").trim();             // 'red'|'orange'|...|'white'
    const size = (req.query.size || "").trim();               // 'small'|'medium'|'large'

    const isTrending = !q || q.toLowerCase() === "trending";
    const base = isTrending
      ? "https://api.pexels.com/v1/curated"
      : "https://api.pexels.com/v1/search";

    const url = new URL(base);
    if (!isTrending) url.searchParams.set("query", q);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(per_page));
    if (orientation) url.searchParams.set("orientation", orientation);
    if (color) url.searchParams.set("color", color);
    if (size) url.searchParams.set("size", size);

    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: "pexels_error" });
    const j = await r.json();

    const results = (j.photos || []).map(normalizePexels);

    // Robust has_more
    let has_more = false;
    if (typeof j.total_results === "number") {
      has_more = page * per_page < j.total_results;
    } else if (j.next_page) {
      has_more = true;
    }

    // Lätt cache på första sidan (övriga no-store)
    if (page === 1) {
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
    } else {
      res.set("Cache-Control", "no-store");
    }

    res.json({ results, page, per_page, total: j.total_results, has_more });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* -------------------------------------------
   /download – streama som attachment (FIX)
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

    const fileUrl = payload?.download_url;
    if (!fileUrl) return res.status(400).json({ error: "bad_token" });

    // Hämta originalet från Pexels
    const upstream = await fetch(fileUrl);
    if (!upstream.ok) return res.status(upstream.status).json({ error: "upstream_error" });

    // Gissa filnamn från URL (sista path-segmentet)
    const u = new URL(fileUrl);
    const last = u.pathname.split("/").pop() || "image";
    const filename = last.includes(".") ? last : `${last}.jpg`;

    // Sätt headers för faktisk nedladdning
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const cl = upstream.headers.get("content-length");
    res.setHeader("Content-Type", ct);
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, max-age=0");

    // node-fetch v3 -> Web ReadableStream; konvertera till Node stream
    const nodeStream =
      typeof upstream.body?.getReader === "function"
        ? Readable.fromWeb(upstream.body)
        : upstream.body;

    // Streama vidare utan lagring
    await pump(nodeStream, res);
  } catch (err) {
    // Om något går snett, svara kontrollerat
    if (!res.headersSent) {
      res.status(400).json({ error: "bad_token" });
    } else {
      // headers redan skickade – stäng bara svar
      try { res.end(); } catch {}
    }
  }
});

/* ---------------------------
   Healthcheck
----------------------------*/
app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () =>
  console.log(`pressify-stock-proxy listening on ${PORT}`)
);

