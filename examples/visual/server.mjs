import http from "node:http";
import fs from "node:fs";
const port = Number(process.env.AEK_VISUAL_PORT ?? 4188);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("AEK_VISUAL_PORT must be an integer between 1 and 65535");
const html = fs.readFileSync(new URL("index.html", import.meta.url));
const server = http.createServer((request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(port, "127.0.0.1");
