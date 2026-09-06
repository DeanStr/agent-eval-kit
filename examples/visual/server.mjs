import http from "node:http";
import fs from "node:fs";
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
server.listen(4188, "127.0.0.1");
