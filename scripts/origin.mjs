/**
 * Stub origin — a stand-in publisher for local end-to-end testing. Serves a tiny
 * HTML article for any path so the tollgate has something real to proxy once a
 * payment clears. NOT for production: point ORIGIN_URL at the real site there.
 *
 *   node scripts/origin.mjs            (or: make origin)   → :3000
 *   ORIGIN_PORT=4000 node scripts/origin.mjs               → :4000
 */
import { createServer } from "node:http";

const PORT = Number(process.env.ORIGIN_PORT ?? 3000);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  const slug = decodeURIComponent((req.url ?? "/").split("?")[0].split("/").filter(Boolean).pop() ?? "essay");
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
