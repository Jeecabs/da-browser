import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { controlledTabMarkScript, CONTROLLED_TAB_CLEAR_SCRIPT } from "../src/controlled-tab.ts";

const root = new URL("../", import.meta.url);
const control = `window.markControlledTab = () => {${controlledTabMarkScript("preview")}};
window.clearControlledTab = () => {${CONTROLLED_TAB_CLEAR_SCRIPT}};`;
const routes = new Map([
  ["/", ["preview/controlled-tab.html", "text/html; charset=utf-8"]],
  ["/favicon-source.png", ["assets/controlled-tab/favicon-source.png", "image/png"]],
  ...[16, 32, 64].map((size) => [
    `/favicon-${size}.png`, [`assets/controlled-tab/favicon-${size}.png`, "image/png"],
  ]),
]);

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Cache-Control", "no-store");
  if (path === "/control.js") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(control);
    return;
  }
  const route = routes.get(path);
  if (!route) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": route[1] });
  response.end(readFileSync(new URL(route[0], root)));
});

server.listen(Number(process.env.PORT || 4317), "127.0.0.1", () => {
  console.log(`Controlled-tab preview: http://127.0.0.1:${server.address().port}`);
});
