// Static stand-in for the Worker routes the browser checks load.
// /g/<id> is group.html, the same file the Worker serves for every group path.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../public/", import.meta.url).pathname;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let path = url.pathname;
  if (path === "/") path = "/index.html";
  else if (path.startsWith("/g/")) path = "/group.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(400);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(4173, "127.0.0.1");
