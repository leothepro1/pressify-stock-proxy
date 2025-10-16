import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const PEXELS_KEY = process.env.PEXELS_API_KEY;

function normalizePexels(photo) {
  return {
    id: `prov:pexels:${photo.id}`,
    source: "pexels",
    thumb: photo.src?.medium,
    full: photo.src?.original,
    width: photo.width,
    height: photo.height,
    orientation: photo.width > photo.height ? "landscape" : photo.width < photo.height ? "portrait" : "square",
    type: "photo",
    author: photo.photographer,
    author_url: photo.photographer_url,
    attribution_required: false,
    download_token: Buffer.from(JSON.stringify({
      src: "pexels",
      download_url: photo.src?.original
    })).toString("base64")
  };
}

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const per_page = Math.min(80, Math.max(1, Number(req.query.per_page || 48)));

    // För vidare extra filter (om klienten skickar dem)
    const orientation = (req.query.orientation || "").trim(); // 'landscape'|'portrait'|'square'
    const color = (req.query.color || "").trim();             // 'red'|'orange'|...|'white'
    const size = (req.query.size || "").trim();               // 'small'|'medium'|'large'

    const isTrending = !q || q.toLowerCase() === "trending";
    const base = isTrending ? "https://api.pexels.com/v1/curated" : "https://api.pexels.com/v1/search";
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

    // Robust "has_more"
    let has_more = false;
    if (typeof j.total_results === "number") {
      has_more = (page * per_page) < j.total_results;
    } else if (j.next_page) {
      has_more = true;
    }

    // Cacha första sidan lätt, undvik cache för sid > 1 vid felsökning
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


app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`pressify-stock-proxy listening on ${PORT}`));
