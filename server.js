// server.js — Express-proxy till Pexels, kompatibel med klienten ovan
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


// GET /search?q=...&page=1&per_page=48&orientation=portrait&color=blue
app.get("/search", async (req, res) => {
try {
const q = (req.query.q || "trending").toString();
const page = Math.max(1, Number(req.query.page || 1));
const per_page = Math.min(80, Math.max(1, Number(req.query.per_page || 48)));
const orientation = (req.query.orientation || "").toString(); // landscape|portrait|square
const color = (req.query.color || "").toString(); // red|orange|...|white|black|hex


const base = q === "trending" ? "https://api.pexels.com/v1/curated" : "https://api.pexels.com/v1/search";
const url = new URL(base);
if (q !== "trending") url.searchParams.set("query", q);
url.searchParams.set("page", String(page));
url.searchParams.set("per_page", String(per_page));
if (orientation) url.searchParams.set("orientation", orientation);
if (color) url.searchParams.set("color", color);


const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
if (!r.ok) return res.status(r.status).json({ error: "pexels_error" });
const j = await r.json();


const results = (j.photos || []).map(normalizePexels);


// Stabil has_more: helst via total_results; fallback till next_page
const total = Number(j.total_results || j.total || 0);
const has_more = total ? (page * per_page) < total : Boolean(j.next_page);


res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
res.json({ results, page, has_more, total_results: total });
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
