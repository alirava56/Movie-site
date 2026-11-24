import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createDidameshServer } from "../server/http.js";

const html = await readFile(new URL("../didamesh (3).html", import.meta.url), "utf8");
const emptyPage = { items: [], nextOffset: null, source: "cinemeta" };

async function host(t, load) {
  const logs = [];
  const server = createDidameshServer({ html, load, logger: { warn: (...args) => logs.push(args) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, root: `http://127.0.0.1:${server.address().port}`, logs, server };
}

test("server serves the built app with restrictive headers and validates API input before loading", async (t) => {
  let requests = 0;
  const { root, port } = await host(t, async () => { requests++; return emptyPage; });
  const app = await fetch(root, { headers: { "accept-encoding": "gzip" } });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get("content-encoding"), "gzip");
  assert.equal(app.headers.get("x-content-type-options"), "nosniff");
  assert.match(app.headers.get("content-security-policy"), /script-src 'sha256-[\w+/=]+'/u);
  assert.match(app.headers.get("content-security-policy"), /connect-src 'self';/u);
  assert.match(app.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.match(await app.text(), /دیدمش!/u);
  const health = await fetch(`${root}/healthz`);
  assert.deepEqual(await health.json(), { status: "ok" });

  const badQuery = await fetch(`${root}/api/catalog?offset=13`);
  assert.equal(badQuery.status, 400);
  await badQuery.arrayBuffer();
  const badMethod = await fetch(`${root}/api/catalog`, { method: "POST" });
  assert.equal(badMethod.status, 405);
  await badMethod.arrayBuffer();
  const foreignOrigin = await fetch(`${root}/api/catalog`, { headers: { Origin: "https://example.com" } });
  assert.equal(foreignOrigin.status, 403);
  await foreignOrigin.arrayBuffer();
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/catalog", headers: { Host: "example.com" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(requests, 0);
});

test("catalog server coalesces and caches successful requests but retries failures without exposing diagnostics", async (t) => {
  let calls = 0;
  let release;
  let reportStart;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reportStart = resolve; });
  const { root, logs, server } = await host(t, async ({ q }) => {
    calls++;
    if (q === "temporary" && calls === 1) throw new Error("internal diagnostic");
    reportStart();
    await gate;
    return emptyPage;
  });
  const url = `${root}/api/catalog?q=temporary`;
  const failure = await fetch(url);
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: "catalog-unavailable" });
  assert.equal(logs.length, 1);

  const first = fetch(url);
  await started;
  const accepted = once(server, "request");
  const second = fetch(url);
  await accepted;
  assert.equal(calls, 2);
  release();
  const hits = await Promise.all([first, second]);
  for (const response of hits) assert.deepEqual(await response.json(), emptyPage);
  const hit = await fetch(url);
  assert.deepEqual(await hit.json(), emptyPage);
  assert.equal(calls, 2);
});
