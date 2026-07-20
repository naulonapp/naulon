/**
 * Stub origin — a stand-in publisher for local end-to-end testing. Serves a tiny
 * HTML article for any path so the tollgate has something real to proxy once a
 * payment clears, plus a discovery catalog so the agent can find candidates.
 * NOT for production: point ORIGIN_URL at the real site there.
 *
 *   node scripts/origin.mjs            (or: make origin)   → :3000
 *   ORIGIN_PORT=4000 node scripts/origin.mjs               → :4000
 *
 * Discovery has no bundled-demo fallback, so `make wayfarer` needs a real
 * source. Point it at this origin:
 *   CATALOG_URL=http://localhost:3000/catalog  make wayfarer TOPIC="…"
 *   RSS_URL=http://localhost:3000/rss.xml       make wayfarer TOPIC="…"
 */
import { createServer } from "node:http";

const PORT = Number(process.env.ORIGIN_PORT ?? 3000);

// A tiny stand-in catalog; the agent discovers these free teasers, then pays the
// tollgate to read each essay's body (served as JSON below, for any slug).
const CATALOG = [
  { slug: "on-stillness", title: "On Stillness", summary: "On attention, silence, and the discipline of staying with one thing." },
  { slug: "the-naulon", title: "The Naulon", summary: "The fare paid to cross — payment, passage, and what we owe for what we take." },
  { slug: "the-river-and-the-name", title: "The River and the Name", summary: "Identity, change, and whether a thing survives the renaming of itself." },
];

/** RSS 2.0 view of the same catalog, for the RSS_URL discovery path. */
function catalogRss() {
  const items = CATALOG.map(
    (c) =>
      `<item><title>${c.title}</title><link>http://localhost:${PORT}/essays/${c.slug}</link>` +
      `<description>${c.summary}</description></item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (path === "/catalog") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CATALOG));
    return;
  }
  if (path === "/rss.xml") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(catalogRss());
    return;
  }
  const slug = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "essay");
  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  // JSON, not HTML: the x402 buyer SDK (@circle-fin/x402-batching) JSON-parses the
  // paid response. A real deployment can content-negotiate — HTML to humans, JSON
  // to paying agents — but the machine-facing body must be JSON.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      slug,
      title,
      content:
        `Full text of the essay "${title}". Humans read this free; ` +
        `a machine reached it by paying the naulon at the tollgate.`,
    }),
  );
});

server.listen(PORT, () => {
  console.log(`🜉 stub origin (publisher stand-in) on http://localhost:${PORT}`);
});
