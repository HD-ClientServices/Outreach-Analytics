// Servidor estático mínimo (sin dependencias) para servir el dashboard en Railway.
// La edge function sigue en Supabase; esto solo hostea dashboard/index.html.
// Railway inyecta PORT; el server DEBE escuchar en process.env.PORT.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "dashboard");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function sendIndex(res) {
  fs.readFile(path.join(ROOT, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); res.end("dashboard/index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // healthcheck simple
  if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }

  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel === "/" || rel === "") return sendIndex(res);

  // resolvé y bloqueá path traversal fuera de ROOT
  const fp = path.join(ROOT, path.normalize(rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.readFile(fp, (err, data) => {
    if (err) return sendIndex(res); // fallback: cualquier ruta desconocida -> el dashboard
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => console.log("Outreach Analytics dashboard escuchando en :" + PORT));
