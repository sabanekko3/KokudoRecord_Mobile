// オフラインで動かすためのサービスワーカー。
// 画面とデータをすべて端末に保存し、以後はネットに出ない（背景地図のタイルは除く）。
// 中身を更新したら js/version.js の APP_VERSION を上げる（キャッシュ名がそれで決まる）。
// 古いキャッシュは activate で消す。
"use strict";

importScripts("js/version.js");
const CACHE = "kokudo-v" + APP_VERSION;

// 最初に開いたときにまとめて保存するもの
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "manifest.json",
  "js/version.js",
  "js/graph.js",
  "js/store.js",
  "js/app.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/images/layers.png",
  "vendor/images/layers-2x.png",
  "vendor/images/marker-icon.png",
  "vendor/images/marker-icon-2x.png",
  "vendor/images/marker-shadow.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "data/index.json",
  "data/lines.json",
  "data/nodes.json",
  "data/eki.json",
  "data/outline.json",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 路線ごとの data/routes/*.json は最初に使ったときに保存する。
// 同じ場所のものはキャッシュを優先し、無ければ取りに行って保存する。
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET" || url.origin !== self.location.origin) return;   // 地図タイルなどは素通し
  ev.respondWith(
    caches.match(ev.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(ev.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(ev.request, copy));
        }
        return res;
      });
    })
  );
});

// 全路線のデータをまとめて端末に入れる（「オフライン用に全部保存」ボタンから）
self.addEventListener("message", (ev) => {
  if (!ev.data || ev.data.type !== "cacheAll") return;
  const urls = ev.data.urls || [];
  const port = ev.ports[0];
  caches.open(CACHE).then(async c => {
    let done = 0;
    for (const u of urls) {
      try {
        if (!(await c.match(u))) await c.add(u);
      } catch (err) {
        port.postMessage({ done, total: urls.length, error: String(err) });
        return;
      }
      done++;
      if (done % 20 === 0) port.postMessage({ done, total: urls.length });
    }
    port.postMessage({ done, total: urls.length, finished: true });
  });
});
