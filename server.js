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
    const q = req.query.q || "trending";
    const page = Number(req.query.page || 1);
    const per_page = Number(req.query.per_page || 48);

    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", q);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(per_page));

    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: "pexels_error" });
    const j = await r.json();

    const results = (j.photos || []).map(normalizePexels);
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
    res.json({ results, page, has_more: Boolean(j.next_page) });
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/download", (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(String(req.query.token), "base64").toString("utf8"));
    return res.redirect(302, payload.download_url); // viktigt: ingen re-hosting
  } catch {
    return res.status(400).json({ error: "bad_token" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`pressify-stock-proxy listening on ${PORT}`));
