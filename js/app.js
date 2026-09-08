// 画面と地図。PC 版（kokudo_map.py のテンプレート）の移植に、端末内の記録を足したもの。
// 計算は graph.js、保存は store.js。ここは Leaflet と DOM だけを扱う。
//
// 起動の流れ:
//   data/index.json（路線一覧）・lines.json（全国の線）・nodes.json（地点名）・eki.json を読む
//   → 記録を IndexedDB から読む → 記録のある路線だけ data/routes/r*.json を読んで
//   走破した辺を求め、線を赤／青に切り分ける → 一覧と走破率を出す
"use strict";

// スクリプトが途中で止まると地図が半分だけ描かれた状態になり、原因が分からない。
// 気づけるように画面へ出す。
function showFatal(text) {
  let box = document.getElementById("fatal");
  if (!box) {
    box = document.createElement("div");
    box.id = "fatal";
    document.body.appendChild(box);
  }
  box.textContent = text;
}
window.addEventListener("error", (ev) => {
  showFatal("地図の読み込みでエラーが起きました。\n" + (ev.message || ev.error || "") + "\n"
    + (ev.filename || "") + " " + (ev.lineno || "") + "行目");
});
window.addEventListener("unhandledrejection", (ev) => {
  showFatal("処理に失敗しました。\n" + (ev.reason && (ev.reason.stack || ev.reason.message) || ev.reason));
});

const $ = (id) => document.getElementById(id);
// URL に ?debug を付けると進み具合を画面の下に出す（スマホには開発者ツールが無い）。
// ?nosw はサービスワーカーを登録しない（動作確認用）。?pointer=fine か coarse で
// 押したときの当たり幅をマウス用／指用に固定する（既定は端末の申告に従う）
const PARAMS = new URLSearchParams(location.search);
function dbg(msg) {
  if (!PARAMS.has("debug")) return;
  let box = document.getElementById("dbglog");
  if (!box) {
    box = document.createElement("pre");
    box.id = "dbglog";
    box.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:35%;overflow:auto;margin:0;z-index:9998;"
      + "background:rgba(22,32,44,.92);color:#fff;padding:6px 10px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap";
    document.body.appendChild(box);
  }
  box.textContent += `${(performance.now() / 1000).toFixed(2)}s ${msg}\n`;
}
const COLORS = { done: "#d81f26", todo: "#2f7fc7", select: "#ffa000" };
const NODE_MIN_ZOOM = 11;      // この倍率から地点の印を出す
const LABEL_MIN_ZOOM = 13;     // この倍率から名前を出す
// 地点の種類。0=名前付き 1=信号 2=国道の交点 3=路線の端
const PT_COLOR = ["#8a96a3", "#0b3f8f", "#0f7b4f", "#111827"];
const PT_SIZE = [2.2, 3, 3.8, 4.2];
// 指で押すときは当たりを広く取る（マウスなら狭くてよい）
const COARSE = PARAMS.has("pointer") ? PARAMS.get("pointer") === "coarse"
  : !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
const NODE_TAP_PX = COARSE ? 24 : 14;   // 地点の印からこの距離（px）までなら、その地点を押したとみなす
const LINE_TAP_PX = COARSE ? 18 : 6;    // 線の当たり判定の最小幅（px）。40m 相当がこれより狭ければこちらを使う
const PT_SCALE = COARSE ? 1.35 : 1;     // 印そのものも少し大きく描く
const STATUS_LABEL = { done: "全線走破", partial: "一部走破", todo: "未走破" };

function esc(text) {
  return String(text).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function round1(x) { return Math.round(x * 10) / 10; }
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を読めません (${res.status})`);
  return res.json();
}

// ---- 状態 --------------------------------------------------------------------
let INDEX = null, LINES = null, NODES = [], EKI = [], NAME_SEP = "／";
const routeIndex = new Map();    // 路線番号 → {ref, km, bounds}
const graphs = new Map();        // 路線番号 → RouteGraph（読んだものだけ）
const summary = new Map();       // 路線番号 → 集計（一覧・ポップアップ用）
const coveredByRef = new Map();  // 路線番号 → Map(辺のキー → km)
let records = [];                // 走破記録（IndexedDB の内容。id 付き）
let visits = new Map();          // 道の駅の訪問（県|駅名 → {date, note}）
let selectedRef = null;          // 一覧で選んだ路線
let recHighlight = null;         // 記録タブで選んだ記録の線（縁取り用）
let recActive = null;            // ハイライト中の記録の id
let pending = null;              // 区間の始点として選んだ地点 {ref, label, text}
let popupNode = null;            // いま開いている地点のポップアップ
let lineLatLng = null;           // 線を押した場所
let filter = "all";
let editingId = null;

// ---- 地図 --------------------------------------------------------------------
const GSI = "https://cyberjapandata.gsi.go.jp/xyz/";
const GSI_CREDIT = "<a href='https://maps.gsi.go.jp/development/ichiran.html'>国土地理院</a>";
const OSM_CREDIT = "道路データ: <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";
const BASEMAPS = {
  blank: { url: GSI + "blank/{z}/{x}/{y}.png", minNativeZoom: 5, maxNativeZoom: 14 },
  pale:  { url: GSI + "pale/{z}/{x}/{y}.png", maxNativeZoom: 18 },
  std:   { url: GSI + "std/{z}/{x}/{y}.png", maxNativeZoom: 18 },
  photo: { url: GSI + "seamlessphoto/{z}/{x}/{y}.jpg", maxNativeZoom: 18 },
  none:  { url: null }
};

const map = L.map("map", { preferCanvas: true }).setView([37.0, 137.5], 6);
map.attributionControl.setPrefix(false).addAttribution(OSM_CREDIT);
let baseLayer = null;

// 使い方。＋−の下に「?」を置き、#help を出す
const HelpControl = L.Control.extend({
  onAdd: function () {
    const bar = L.DomUtil.create("div", "leaflet-bar");
    const a = L.DomUtil.create("a", "help-btn", bar);
    a.href = "#";
    a.textContent = "?";
    a.title = "使い方";
    a.setAttribute("role", "button");
    a.setAttribute("aria-label", "使い方");
    L.DomEvent.on(a, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); showHelp(true); });
    L.DomEvent.disableClickPropagation(bar);
    return bar;
  }
});
new HelpControl({ position: "topleft" }).addTo(map);
function showHelp(open) {
  $("help").hidden = !open;
  if (open) $("help").querySelector(".help-body").scrollTop = 0;
}
$("help").addEventListener("click", (e) => {
  if (e.target === $("help") || e.target.closest("[data-help-close]")) showHelp(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("help").hidden) showHelp(false); });

function setBasemap(key) {
  if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
  const spec = BASEMAPS[key] || BASEMAPS.none;
  $("map").style.background = key === "photo" ? "#2b2f33" : "#f5f7f9";
  try { localStorage.setItem("basemap", key); } catch (err) { /* 保存できなくてもよい */ }
  if (!spec.url) return;
  baseLayer = L.tileLayer(spec.url, {
    attribution: "地図データ: " + GSI_CREDIT, maxZoom: 18,
    minNativeZoom: spec.minNativeZoom, maxNativeZoom: spec.maxNativeZoom,
    opacity: Number($("opacity").value) / 100
  });
  baseLayer.addTo(map);
  baseLayer.bringToBack();
}

// 線も道の駅も1枚のキャンバスに描く。pane を分けると上のキャンバスが下の線への
// クリックを飲み込む。線は interactive にしない（Leaflet の判定は線の幅ぶんしか無く
// 指には狭い）。押した場所の判定は map の click で routesAtPoint() が自分でやる。
// 道の駅だけは Leaflet に任せ、bubblingMouseEvents を切って map の click に流さない
map.createPane("featPane").style.zIndex = 420;
const featRenderer = L.canvas({ pane: "featPane", padding: 0.3 });
map.createPane("selPane").style.zIndex = 405;

const layerSel = L.featureGroup([], { pane: "selPane" }).addTo(map);
const selRenderer = L.canvas({ pane: "selPane" });
const groupTodo = L.featureGroup();
const groupDone = L.featureGroup();
const groupEki = L.featureGroup();
const routeLayers = new Map();   // 路線番号 → {done: Polyline|null, todo: Polyline|null}
const ekiMarkers = [];

function todoStyle(ref) {
  if (ref === selectedRef) return { color: COLORS.todo, weight: 2.8, opacity: 1 };
  return { color: COLORS.todo, weight: 1.4, opacity: selectedRef ? 0.18 : 0.85 };
}
function doneStyle(ref) {
  if (ref === selectedRef) return { color: COLORS.done, weight: 4.5, opacity: 1 };
  return { color: COLORS.done, weight: 2.8, opacity: selectedRef ? 0.16 : 0.95 };
}

// 1路線の線を置き直す。lines は [[緯度, 経度], ...] の並び
function setRouteLines(ref, doneLines, todoLines) {
  const old = routeLayers.get(ref);
  if (old) {
    if (old.done) groupDone.removeLayer(old.done);
    if (old.todo) groupTodo.removeLayer(old.todo);
  }
  const make = (lines, kind, style) => {
    if (!lines.length) return null;
    const pl = L.polyline(lines, Object.assign({ pane: "featPane", renderer: featRenderer, interactive: false }, style));
    pl.ref = ref;
    pl.kind = kind;
    (kind === "done" ? groupDone : groupTodo).addLayer(pl);
    return pl;
  };
  routeLayers.set(ref, { done: make(doneLines, "done", doneStyle(ref)),
                         todo: make(todoLines, "todo", todoStyle(ref)) });
  raiseDone();
}

// 赤（走破済み）と道の駅を青（未走破）より上に描く。キャンバスは追加した順に描くので、
// 置き直した青線は末尾に付き、重複区間で他路線の赤の上に乗ってしまう。置き直すたびに上げ直す
function raiseDone() {
  groupDone.eachLayer(l => l.bringToFront());
  groupEki.eachLayer(l => l.bringToFront());
}

// 重ね順を作り直す。未走破 → 走破済み → 道の駅の順で、あとのものが上に来る
function stackLayers() {
  for (const g of [groupTodo, groupDone, groupEki]) if (map.hasLayer(g)) map.removeLayer(g);
  if ($("showTodo").checked) groupTodo.addTo(map);
  groupDone.addTo(map);
  if ($("showEki").checked) groupEki.addTo(map);
}

function restyleRoutes() {
  for (const [ref, l] of routeLayers) {
    if (l.done) l.done.setStyle(doneStyle(ref));
    if (l.todo) l.todo.setStyle(todoStyle(ref));
  }
}

// 選択を地図と一覧の両方に反映する
function refreshSelection() {
  layerSel.clearLayers();
  const add = (lines) => {
    if (lines && lines.length) {
      layerSel.addLayer(L.polyline(lines, { pane: "selPane", renderer: selRenderer, interactive: false,
                                            color: COLORS.select, weight: 10, opacity: 0.55 }));
    }
  };
  if (recHighlight) {
    add(recHighlight);
  } else if (selectedRef) {
    const l = routeLayers.get(selectedRef);
    if (l) {
      if (l.done) add(l.done.getLatLngs());
      if (l.todo && $("showTodo").checked) add(l.todo.getLatLngs());
    }
  }
  restyleRoutes();
  for (const b of $("list").querySelectorAll(".row")) {
    b.setAttribute("aria-pressed", String(b.dataset.ref === selectedRef));
  }
}

function selectRoute(ref) {
  recActive = null;
  recHighlight = null;
  selectedRef = (selectedRef === ref) ? null : ref;
  refreshSelection();
  renderRecords();
  return selectedRef !== null;
}

// ---- 走破の計算 --------------------------------------------------------------
async function loadGraph(ref) {
  let g = graphs.get(ref);
  if (!g) {
    g = new Graph.RouteGraph(await fetchJson(`data/routes/r${ref}.json`));
    graphs.set(ref, g);
  }
  return g;
}

function baseSummary(ref) {
  const base = routeIndex.get(ref);
  return { ref, km: base.km, doneKm: 0, status: "todo", sections: [], dates: [], notes: [],
           bounds: base.bounds, warnings: [] };
}

// その路線の記録を区間指定の並びにする
function sectionsFor(ref) {
  const secs = [], errors = [];
  for (const r of records) {
    if (r.ref !== ref) continue;
    const p = Graph.parseRow(r.ref, r.section, r.date, r.note);
    secs.push(...p.items);
    errors.push(...p.errors);
  }
  return { secs, errors };
}

// 1路線を計算し直して線と集計を更新する
async function recompute(ref) {
  if (!routeIndex.has(ref)) return;
  const { secs, errors } = sectionsFor(ref);
  const s = baseSummary(ref);
  s.warnings = errors;
  if (secs.length) {
    const g = await loadGraph(ref);
    const cov = Graph.routeCovered(g, secs);
    s.doneKm = round1(cov.doneKm);
    s.status = Graph.routeStatus(g.km, cov.doneKm, cov.covered);
    s.sections = cov.sections;
    s.dates = cov.dates;
    s.notes = cov.notes;
    s.warnings = errors.concat(cov.warnings);
    const km = new Map();
    for (const key of cov.covered) km.set(key, g.edges.get(key));
    coveredByRef.set(ref, km);
    const lines = Graph.splitLines(g, cov.covered);
    setRouteLines(ref, lines.done, lines.todo);
  } else {
    coveredByRef.delete(ref);
    setRouteLines(ref, [], (LINES[ref] || []).map(Graph.decodeLatLngs));
  }
  summary.set(ref, s);
}

// 走破率。重複区間を二重に数えないよう、走破した辺の集合の和で出す
function refreshStats() {
  const union = new Map();
  for (const km of coveredByRef.values()) for (const [k, v] of km) union.set(k, v);
  let doneKm = 0;
  for (const v of union.values()) doneKm += v;
  doneKm = Math.round(doneKm);
  const totalKm = INDEX.totalKm;
  let doneRoutes = 0, partialRoutes = 0;
  for (const s of summary.values()) {
    if (s.status === "done") doneRoutes++;
    else if (s.status === "partial") partialRoutes++;
  }
  let ekiDone = 0;
  for (const e of EKI) { const v = visits.get(Store.ekiKey(e[3], e[2])); if (v && v.date) ekiDone++; }

  const pc = totalKm ? doneKm / totalKm * 100 : 0;
  $("pct").textContent = pc.toFixed(1);
  $("bar").style.width = Math.max(pc, 0.4) + "%";
  $("detail").innerHTML =
    `${doneKm.toLocaleString()} / ${totalKm.toLocaleString()} km<br>` +
    `全線走破 ${doneRoutes} 本・一部走破 ${partialRoutes} 本 / 収録 ${summary.size} 本` +
    (EKI.length ? `<br>道の駅 ${ekiDone.toLocaleString()} / ${EKI.length.toLocaleString()} 駅` +
                  `（${(ekiDone / EKI.length * 100).toFixed(1)}%）` : "");
}

// ---- 路線の一覧 --------------------------------------------------------------
function popupHtml(s) {
  const bits = [
    `<strong style="font-size:14px">国道${s.ref}号</strong>`,
    `${STATUS_LABEL[s.status]}　${s.doneKm.toLocaleString()} / ${s.km.toLocaleString()} km`
  ];
  if (s.sections.length) bits.push(`区間: ${esc(s.sections.join(" ／ "))}`);
  if (s.dates.length) bits.push(`走破日: ${esc(s.dates.join(", "))}`);
  if (s.notes.length) bits.push(esc(s.notes.join(" / ")));
  return bits.join("<br>");
}

function render() {
  const listEl = $("list");
  const rows = [...summary.values()].filter(s => filter === "all" || s.status === filter);
  listEl.innerHTML = "";
  if (!rows.length) {
    listEl.innerHTML = '<p style="padding:20px;font-size:12px;color:#6c7a89">該当する路線はありません</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of rows) {
    // 行は div。中に「路線を選ぶ」ボタンと、未走破・一部走破なら「全線走破」ボタン
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.ref = s.ref;
    row.setAttribute("aria-pressed", String(s.ref === selectedRef));
    const sub = s.status === "partial"
      ? `${s.doneKm.toLocaleString()} / ${s.km.toLocaleString()} km　${esc(s.sections.join("・"))}`
      : `${s.km.toLocaleString()} km`;
    row.innerHTML =
      `<button class="row-main" type="button">` +
      `<span class="shield ${s.status}"><span>${s.ref}</span></span>` +
      `<span class="meta"><span class="name">国道${s.ref}号</span><br><span class="sub">${sub}</span></span></button>` +
      (s.status === "done" ? "" : `<button class="btn full" type="button" data-full="${s.ref}" title="始点から終点まで全部を走破として記録する">全線走破</button>`);
    row.querySelector(".row-main").addEventListener("click", () => {
      if (!selectRoute(s.ref)) { map.closePopup(); return; }
      showMap();
      fitVisible(s.bounds);
      L.popup()
        .setLatLng([(s.bounds[0][0] + s.bounds[1][0]) / 2, (s.bounds[0][1] + s.bounds[1][1]) / 2])
        .setContent(popupHtml(s)).openOn(map);
    });
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

// ---- 線のクリック ------------------------------------------------------------
function segDist2(p, a, b) {
  const bx = b.x - a.x, by = b.y - a.y;
  const d2 = bx * bx + by * by;
  const t = d2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * bx + (p.y - a.y) * by) / d2)) : 0;
  const dx = p.x - (a.x + t * bx), dy = p.y - (a.y + t * by);
  return dx * dx + dy * dy;
}

// その地点を通っている国道をすべて拾う（重複区間で選べるように）。
// 路線ごとに独立して間引いているので線が数十mずれる。40m 相当を画素に換算し、
// 指で押すときはそれより広い最小幅（LINE_TAP_PX）を保つ
function routesAtPoint(latlng) {
  const p = map.latLngToLayerPoint(latlng);
  const mPerPx = 156543.03 * Math.cos(latlng.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
  const tol = Math.min(30, Math.max(LINE_TAP_PX, 40 / mPerPx));
  const tol2 = tol * tol;
  const refs = new Set();
  for (const g of [groupDone, groupTodo]) {
    if (!map.hasLayer(g)) continue;
    g.eachLayer(l => {
      if (!l.ref || refs.has(l.ref) || !l._parts) return;
      for (const part of l._parts) {
        for (let i = 1; i < part.length; i++) {
          if (segDist2(p, part[i - 1], part[i]) <= tol2) { refs.add(l.ref); return; }
        }
      }
    });
  }
  return [...refs].sort((a, b) => Number(a) - Number(b));
}

function linePopupHtml(refs) {
  const rows = refs.map(ref => {
    const s = summary.get(ref);
    if (!s) return "";
    const act = (pending && pending.ref === ref)
      ? `<button class="btn go" data-pt-finish="${ref}">ここまで</button>`
      : `<button class="btn" data-pt-start="${ref}">ここから</button>`;
    return `<tr><td style="padding-right:9px"><b>国道${ref}号</b></td>`
      + `<td style="padding-right:9px">${STATUS_LABEL[s.status]}　`
      + `${s.doneKm.toLocaleString()} / ${s.km.toLocaleString()} km</td>`
      + `<td>${act}</td></tr>`;
  }).join("");
  const bits = [`<strong style="font-size:13px">この地点を通る国道</strong>`
    + `<table style="margin:6px 0 2px;border-collapse:collapse">${rows}</table>`];
  if (refs.length === 1) {
    const s = summary.get(refs[0]);
    if (s && s.sections.length) bits.push(`<span style="font-size:11px">区間: ${esc(s.sections.join(" ／ "))}</span>`);
    if (s && s.dates.length) bits.push(`<span style="font-size:11px">走破日: ${esc(s.dates.join(", "))}</span>`);
  }
  return bits.join("<br>");
}

function openLinePopup(latlng) {
  lineLatLng = latlng;
  const refs = routesAtPoint(latlng);
  if (!refs.length) return false;
  L.popup().setLatLng(latlng).setContent(linePopupHtml(refs)).openOn(map);
  return true;
}

// ---- 道の駅 ------------------------------------------------------------------
// 星形にして交差点の丸と見分ける。描き方だけ差し替え、当たり判定は丸のまま
const StarMarker = L.CircleMarker.extend({
  _updatePath: function () {
    const r = this._renderer;
    if (!r._ctx) { L.CircleMarker.prototype._updatePath.call(this); return; }
    if (!r._drawing || this._empty()) return;
    const ctx = r._ctx, p = this._point, rad = Math.max(this._radius, 1);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + i * Math.PI / 5;
      const rr = (i % 2) ? rad * 0.45 : rad;
      const x = p.x + Math.cos(ang) * rr, y = p.y + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    r._fillStroke(ctx, this);
  }
});

function ekiVisit(i) {
  const e = EKI[i];
  return visits.get(Store.ekiKey(e[3], e[2])) || null;
}
function ekiStyle(been) {
  return { radius: been ? 8 : 7, fillColor: been ? COLORS.done : COLORS.todo, fillOpacity: been ? 1 : 0.85 };
}
function ekiPopup(i) {
  const e = EKI[i], v = ekiVisit(i), been = !!(v && v.date);
  return `<strong style="font-size:13px">道の駅 ${esc(e[2])}</strong>` +
    `<br><span style="font-size:11px;color:#6c7a89">${esc(e[3])}</span>` +
    (been ? `<br>訪問: ${esc(v.date)}` : `<br><span style="color:#6c7a89">未訪問</span>`) +
    (v && v.note ? `<br>${esc(v.note)}` : "") +
    `<br><button class="btn ${been ? "off" : "go"}" data-eki="${i}">${been ? "訪問を取り消す" : "行った"}</button>`;
}
function buildEki() {
  EKI.forEach((e, i) => {
    const been = !!(ekiVisit(i) && ekiVisit(i).date);
    const marker = new StarMarker([e[0], e[1]], Object.assign({
      pane: "featPane", renderer: featRenderer, bubblingMouseEvents: false,
      color: "#fff", weight: 1.6, opacity: 0.95, lineJoin: "round"
    }, ekiStyle(been)));
    marker.bindPopup(() => ekiPopup(i));
    groupEki.addLayer(marker);
    ekiMarkers[i] = marker;
  });
}
async function toggleEki(i) {
  const e = EKI[i], v = ekiVisit(i);
  const been = !!(v && v.date);
  const date = been ? "" : today();
  await Store.setEkiVisit(e[3], e[2], date, v ? v.note : "");
  visits.set(Store.ekiKey(e[3], e[2]), { key: Store.ekiKey(e[3], e[2]), pref: e[3], name: e[2], date, note: v ? v.note : "" });
  ekiMarkers[i].setStyle(ekiStyle(!been));
  ekiMarkers[i].setPopupContent(ekiPopup(i));
  refreshStats();
}

// ---- 交差点名の注記 ----------------------------------------------------------
// 数万地点あるのでマーカーは使わず、表示範囲に入るぶんだけキャンバスに描く
const NODE_GRID = 0.05;
const NODE_DRAW_LIMIT = 2000;
const nodeIndex = new Map();

map.createPane("labelPane");
const labelPane = map.getPane("labelPane");
labelPane.style.zIndex = 450;
labelPane.style.pointerEvents = "none";
const labelCanvas = L.DomUtil.create("canvas", "", labelPane);
labelCanvas.style.position = "absolute";
const lctx = labelCanvas.getContext("2d");
const NAME_FONT = '600 11px "BIZ UDPGothic","Noto Sans JP","Yu Gothic UI",sans-serif';
const TAG_FONT = '500 9px "BIZ UDPGothic","Noto Sans JP","Yu Gothic UI",sans-serif';
const TAG_LINE = 10;
let zooming = false;
let drawn = [];                  // いま画面に描いてある地点 {n, x, y}（押した場所の判定に使う）

function buildNodeIndex() {
  nodeIndex.clear();
  for (const n of NODES) {
    const key = Math.floor(n[0] / NODE_GRID) + "," + Math.floor(n[1] / NODE_GRID);
    let cell = nodeIndex.get(key);
    if (!cell) nodeIndex.set(key, cell = []);
    cell.push(n);
  }
}
function nodeTags(n) {
  return (n[4] || []).map(p => "R" + p[0] + "/" + (p[1] === null ? "?" : p[1]));
}
function sizeLabelCanvas() {
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  labelCanvas.width = size.x * dpr;
  labelCanvas.height = size.y * dpr;
  labelCanvas.style.width = size.x + "px";
  labelCanvas.style.height = size.y + "px";
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function clearLabels() {
  const size = map.getSize();
  lctx.clearRect(0, 0, size.x, size.y);
  drawn = [];
}
function visibleNodes() {
  const b = map.getBounds();
  const out = [];
  const y0 = Math.floor(b.getSouth() / NODE_GRID), y1 = Math.floor(b.getNorth() / NODE_GRID);
  const x0 = Math.floor(b.getWest() / NODE_GRID), x1 = Math.floor(b.getEast() / NODE_GRID);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cell = nodeIndex.get(y + "," + x);
      if (!cell) continue;
      for (const n of cell) if (b.contains([n[0], n[1]])) out.push(n);
    }
  }
  return out;
}
function drawLabels() {
  L.DomUtil.setPosition(labelCanvas, map.containerPointToLayerPoint([0, 0]));
  clearLabels();
  const z = map.getZoom();
  if (!$("showNodes").checked || z < NODE_MIN_ZOOM) return;
  const withText = z >= LABEL_MIN_ZOOM;
  const found = visibleNodes();
  found.sort((a, b) => b[3] - a[3]);
  if (found.length > NODE_DRAW_LIMIT) found.length = NODE_DRAW_LIMIT;
  lctx.textBaseline = "middle";
  lctx.lineJoin = "round";
  const HALO = "rgba(255,255,255,.92)";
  const boxes = [];
  for (const n of found) {
    const p = map.latLngToContainerPoint([n[0], n[1]]);
    const r = (PT_SIZE[n[3]] || 2.2) * PT_SCALE;
    drawn.push({ n, x: p.x, y: p.y });
    lctx.beginPath();
    if (n[3] >= 2) {
      lctx.moveTo(p.x, p.y - r); lctx.lineTo(p.x + r, p.y);
      lctx.lineTo(p.x, p.y + r); lctx.lineTo(p.x - r, p.y);
      lctx.closePath();
    } else {
      lctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    lctx.strokeStyle = "rgba(255,255,255,.9)";
    lctx.lineWidth = 1.4;
    lctx.stroke();
    lctx.fillStyle = PT_COLOR[n[3]] || "#8a96a3";
    lctx.fill();
    if (!withText) continue;

    const tags = nodeTags(n);
    const inline = tags.length <= 2 ? tags.join(" ") : "";
    const stack = tags.length > 2 ? tags : [];
    lctx.font = NAME_FONT;
    const w1 = lctx.measureText(n[2]).width;
    lctx.font = TAG_FONT;
    const wInline = inline ? lctx.measureText(inline).width + 4 : 0;
    let wStack = 0;
    for (const t of stack) wStack = Math.max(wStack, lctx.measureText(t).width);
    const tx = p.x + 6, ty = p.y;
    const w = Math.max(w1 + wInline, wStack);
    const box = [tx - 2, ty - 8, tx + w + 2, ty + 8 + stack.length * TAG_LINE];
    if (boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
    boxes.push(box);

    lctx.font = NAME_FONT;
    lctx.lineWidth = 3.2;
    lctx.strokeStyle = HALO;
    lctx.strokeText(n[2], tx, ty);
    lctx.fillStyle = "#16202c";
    lctx.fillText(n[2], tx, ty);
    lctx.font = TAG_FONT;
    lctx.lineWidth = 3;
    if (inline) {
      lctx.strokeStyle = HALO;
      lctx.strokeText(inline, tx + w1 + 4, ty);
      lctx.fillStyle = "#0b3f8f";
      lctx.fillText(inline, tx + w1 + 4, ty);
    }
    for (let i = 0; i < stack.length; i++) {
      const y = ty + TAG_LINE * (i + 1);
      lctx.strokeStyle = HALO;
      lctx.strokeText(stack[i], tx, y);
      lctx.fillStyle = "#0b3f8f";
      lctx.fillText(stack[i], tx, y);
    }
  }
}

// 押した場所に一番近い地点の印（NODE_TAP_PX 以内）。名前を描けなかった地点も含む
function nodeAt(p) {
  let best = null, bestD = NODE_TAP_PX * NODE_TAP_PX;
  for (const it of drawn) {
    const d = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = it.n; }
  }
  return best;
}

// 地図を押したら、近くの地点の印 → 道の線 の順に探す。地点は必ず線の上にあるので、
// 先に地点を見ないと線のポップアップに取られてしまう
map.on("click", (e) => {
  const n = nodeAt(map.latLngToContainerPoint(e.latlng));
  if (n) openNodePopup(n);
  else openLinePopup(e.latlng);
});

// 地点のポップアップ。どの路線の区間端にするかを選ぶ
function openNodePopup(n) {
  popupNode = n;
  const canon = n[2].split(NAME_SEP)[0];
  const rows = (n[4] || []).map(pair => {
    const km = pair[1];
    const where = km === null ? `<span style="color:#6c7a89">距離不明</span>` : `${km} km`;
    const act = (pending && pending.ref === pair[0])
      ? `<button class="btn go" data-finish="${pair[0]}">ここまで</button>`
      : `<button class="btn" data-start="${pair[0]}">ここから</button>`;
    return `<tr><td style="padding-right:10px">国道${pair[0]}号</td><td style="padding-right:8px">${where}</td><td>${act}</td></tr>`;
  }).join("");
  L.popup().setLatLng([n[0], n[1]]).setContent(
    `<strong style="font-size:13px">${esc(n[2])}</strong>` + (n[3] === 1 ? "　信号交差点" : "") +
    `<table style="margin:6px 0 2px;border-collapse:collapse">${rows}</table>` +
    `<span style="font-size:10.5px;color:#6c7a89">${esc(canon)}@${n[0]}/${n[1]}</span>`
  ).openOn(map);
}

map.on("move", () => { if (!zooming) drawLabels(); });
map.on("zoomstart", () => { zooming = true; clearLabels(); });
map.on("zoomend", () => { zooming = false; drawLabels(); });
map.on("resize", () => { sizeLabelCanvas(); drawLabels(); });

// ---- スマホの下パネル（ボトムシート） ------------------------------------------
// 760px 以下では地図が画面いっぱいで、パネルは下から引き出す。peek（つまみ・走破率・
// 編集の帯だけ）／half／full を #side のクラスで切り替え、つまみのタップで peek と half を
// 行き来、ドラッグで好きな高さにして離すと近い段に寄せる。広い画面ではクラスは効かない
const MOBILE = window.matchMedia("(max-width: 760px)");
const sideEl = $("side");
const gripEl = $("grip");
let sheetState = "peek";

function setSheet(state) {
  sheetState = state;
  sideEl.classList.remove("peek", "half", "full");
  sideEl.classList.add(state);
  sideEl.style.height = "";
  gripEl.setAttribute("aria-expanded", String(state !== "peek"));
}
// 一覧から地図を見に行くとき。畳んで、すぐ測れるように transition を切る
function showMap() {
  if (!MOBILE.matches || sheetState === "peek") return;
  sideEl.classList.add("dragging");
  setSheet("peek");
  void sideEl.offsetHeight;
  sideEl.classList.remove("dragging");
}
// シートが隠している高さ（px）。fitBounds の下側の余白に足す
function sheetCover() {
  return MOBILE.matches ? sideEl.getBoundingClientRect().height : 0;
}
function fitVisible(bounds) {
  map.fitBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: [30, 30 + sheetCover()] });
}

let sheetDrag = null;
gripEl.addEventListener("pointerdown", (e) => {
  if (!MOBILE.matches) return;
  sheetDrag = { y: e.clientY, h: sideEl.getBoundingClientRect().height, moved: false };
  gripEl.setPointerCapture(e.pointerId);
  sideEl.classList.add("dragging");
});
gripEl.addEventListener("pointermove", (e) => {
  if (!sheetDrag) return;
  const dy = sheetDrag.y - e.clientY;
  if (!sheetDrag.moved) {
    if (Math.abs(dy) < 6) return;
    sheetDrag.moved = true;
    // 畳んだままだと中身が display:none なので、引き上げながら見えるようにしておく
    sideEl.classList.remove("peek", "half", "full");
    sideEl.classList.add("half");
  }
  sideEl.style.height = Math.max(40, sheetDrag.h + dy) + "px";
});
function endSheetDrag() {
  if (!sheetDrag) return;
  const moved = sheetDrag.moved;
  sheetDrag = null;
  sideEl.classList.remove("dragging");
  if (!moved) { setSheet(sheetState === "peek" ? "half" : "peek"); return; }
  const ratio = sideEl.getBoundingClientRect().height / $("app").clientHeight;
  setSheet(ratio < 0.3 ? "peek" : ratio < 0.72 ? "half" : "full");
}
gripEl.addEventListener("pointerup", endSheetDrag);
gripEl.addEventListener("pointercancel", endSheetDrag);
gripEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(sheetState === "peek" ? "half" : "peek"); }
});
// 題名を押しても開閉する
document.querySelector(".titlebar > div").addEventListener("click", () => {
  if (MOBILE.matches) setSheet(sheetState === "peek" ? "half" : "peek");
});
setSheet("peek");
if (MOBILE.matches) map.attributionControl.setPosition("topright");

// ---- 区間の記録 --------------------------------------------------------------
const editEl = $("edit");
function showEdit(html) {
  editEl.innerHTML = html;
  editEl.classList.toggle("on", !!html);
  if (html) editEl.scrollIntoView({ block: "nearest" });
}
const CLOSE = `<br><button class="btn" data-cancel="1">閉じる</button>`;

function startSection(ref, label, text) {
  pending = { ref, label, text };
  showEdit(`国道${ref}号 <b>${esc(label)}</b> から<br>もう一方の地点を押して「ここまで」を選んでください` +
    `<br><button class="btn" data-cancel="1">やめる</button>`);
  map.closePopup();
}

async function finishSection(ref, label, text) {
  if (!pending || pending.ref !== ref) return;
  const a = pending, b = { label, text };
  pending = null;
  map.closePopup();
  const title = `国道${ref}号 <b>${esc(a.label)}〜${esc(b.label)}</b>`;
  showEdit(`${title} を計算しています…`);
  const section = `${a.text}〜${b.text}`;
  const g = await loadGraph(ref);
  const parsed = Graph.parseRow(ref, section, today(), "");
  const cov = Graph.routeCovered(g, parsed.items);
  if (!cov.covered.size) {
    showEdit(`<b>記録できませんでした</b><br>${esc(cov.warnings.concat(parsed.errors).join(" / ") || "区間を特定できません")}${CLOSE}`);
    return;
  }
  const id = await Store.addRecord({ ref, section, date: today(), note: "" });
  records.push({ id, ref, section, date: today(), note: "" });
  await recompute(ref);
  refreshStats();
  render();
  renderRecords();
  const s = summary.get(ref);
  showEdit(`${title} を記録しました（${round1(cov.doneKm)} km）<br>` +
    `国道${ref}号 ${s.doneKm.toLocaleString()} / ${s.km.toLocaleString()} km${CLOSE}`);
}

// 「全線走破」。地点を選ばずに区間 `全線` の記録を1件足す。始点と終点をうまく
// 選べない路線のための逃げ道。CSV に「全線」と書くのと同じ
function askFull(ref) {
  pending = null;
  const s = summary.get(ref);
  const note = s && s.sections.length
    ? `<span class="hint">いまの ${s.sections.length} 件の区間の記録はそのまま残ります（走破記録タブで消せます）</span>` : "";
  showEdit(`国道${ref}号 <b>全線</b>（${s ? s.km.toLocaleString() : "?"} km）を走破として記録しますか？${note}` +
    `<br><button class="btn go" data-full-ok="${ref}">記録する</button><button class="btn" data-cancel="1">やめる</button>`);
}
async function recordFull(ref) {
  showEdit(`国道${ref}号 <b>全線</b> を計算しています…`);
  const id = await Store.addRecord({ ref, section: Graph.FULL, date: today(), note: "" });
  records.push({ id, ref, section: Graph.FULL, date: today(), note: "" });
  await recompute(ref);
  refreshStats();
  render();
  renderRecords();
  const s = summary.get(ref);
  showEdit(`国道${ref}号 <b>全線</b> を記録しました<br>` +
    `国道${ref}号 ${s.doneKm.toLocaleString()} / ${s.km.toLocaleString()} km${CLOSE}`);
}

// 画面じゅうのボタンをまとめて受ける
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-eki], button[data-start], button[data-finish], " +
                               "button[data-cancel], button[data-pt-start], button[data-pt-finish], " +
                               "button[data-full], button[data-full-ok], " +
                               "button[data-tab], button[data-rec-go], button[data-rec-edit], " +
                               "button[data-rec-del], button[data-rec-save], button[data-rec-cancel]");
  if (!btn) return;
  ev.preventDefault();
  const fail = (err) => showEdit(`<b>失敗しました</b><br>${esc(err.message)}${CLOSE}`);

  if (btn.hasAttribute("data-cancel")) {
    pending = null;
    showEdit("");
    if (recActive !== null) {
      recActive = null; recHighlight = null; selectedRef = null;
      refreshSelection(); renderRecords();
    }
  } else if (btn.hasAttribute("data-eki")) {
    toggleEki(Number(btn.dataset.eki)).catch(fail);
  } else if (btn.hasAttribute("data-start") || btn.hasAttribute("data-finish")) {
    const ref = btn.dataset.start || btn.dataset.finish;
    const pair = popupNode && (popupNode[4] || []).find(x => x[0] === ref);
    if (!pair) return;
    // 1つの地点に複数の呼び名が付くことがある。区間欄には結合前の名前を書く
    const canon = popupNode[2].split(NAME_SEP)[0];
    const text = pair[1] === null ? `${canon}@${popupNode[0]}/${popupNode[1]}` : `${canon}@${pair[1]}`;
    if (btn.hasAttribute("data-start")) startSection(ref, popupNode[2], text);
    else finishSection(ref, popupNode[2], text).catch(fail);
  } else if (btn.hasAttribute("data-pt-start") || btn.hasAttribute("data-pt-finish")) {
    if (!lineLatLng) return;
    const ref = btn.dataset.ptStart || btn.dataset.ptFinish;
    const lat = lineLatLng.lat.toFixed(5), lon = lineLatLng.lng.toFixed(5);
    const text = `@${lat}/${lon}`, label = `地点(${lat},${lon})`;
    if (btn.hasAttribute("data-pt-start")) startSection(ref, label, text);
    else finishSection(ref, label, text).catch(fail);
  } else if (btn.hasAttribute("data-full")) {
    askFull(btn.dataset.full);
  } else if (btn.hasAttribute("data-full-ok")) {
    recordFull(btn.dataset.fullOk).catch(fail);
  } else if (btn.hasAttribute("data-tab")) {
    showTab(btn.dataset.tab);
  } else if (btn.hasAttribute("data-rec-go")) {
    showRecord(Number(btn.dataset.recGo)).catch(fail);
  } else if (btn.hasAttribute("data-rec-edit")) {
    editingId = Number(btn.dataset.recEdit);
    renderRecords();
  } else if (btn.hasAttribute("data-rec-cancel")) {
    editingId = null;
    renderRecords();
  } else if (btn.hasAttribute("data-rec-save")) {
    saveRecord(Number(btn.dataset.recSave)).catch(fail);
  } else if (btn.hasAttribute("data-rec-del")) {
    deleteRecord(Number(btn.dataset.recDel)).catch(fail);
  }
});

// ---- 走破記録タブ ------------------------------------------------------------
function showTab(name) {
  $("paneRoutes").hidden = name !== "routes";
  $("paneRecords").hidden = name !== "records";
  for (const b of $("tabs").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.tab === name));
  }
  if (name === "records") renderRecords();
}

function renderRecords() {
  const el = $("paneRecords");
  if (el.hidden) return;
  if (!records.length) {
    el.innerHTML = '<p style="padding:16px;font-size:12px;color:#6c7a89">記録はまだありません。地図で地点を2つ選ぶと増えます。</p>';
    return;
  }
  const html = records.map((r, i) => {
    const on = r.id === recActive;
    const s = summary.get(r.ref);
    const warn = s && s.warnings.find(w => w.includes(r.section) || w.includes(r.section.split(/[〜～~]/)[0]));
    if (editingId === r.id) {
      return `<div class="rec on">
        <div class="head"><span class="num">${i + 1}</span><span class="sec">国道${esc(r.ref)}号　${esc(r.section)}</span></div>
        <div class="grid">
          <input id="recDate" value="${esc(r.date)}" placeholder="走破日（2026/9/7）" inputmode="numeric">
          <input id="recNote" value="${esc(r.note)}" placeholder="メモ">
        </div>
        <div class="foot"><button class="btn go" data-rec-save="${r.id}">保存</button>
          <button class="btn" data-rec-cancel="1">やめる</button></div></div>`;
    }
    return `<div class="rec${on ? " on" : ""}">
      <button class="head" data-rec-go="${r.id}" type="button"><span class="num">${i + 1}</span>
        <span class="sec">国道${esc(r.ref)}号　${esc(r.section)}</span></button>
      <div class="foot"><span class="when">${esc(r.date || "走破日なし")}${r.note ? "　" + esc(r.note) : ""}</span>
        <button class="btn" data-rec-edit="${r.id}">編集</button>
        <button class="btn warn" data-rec-del="${r.id}">削除</button></div>
      ${warn ? `<div class="warn">${esc(warn)}</div>` : ""}</div>`;
  }).join("");
  el.innerHTML = html;
}

// 記録1件がどこを指しているかを縁取りで見せる
async function showRecord(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  if (recActive === id) {
    recActive = null; recHighlight = null; refreshSelection(); renderRecords();
    return;
  }
  const g = await loadGraph(r.ref);
  const parsed = Graph.parseRow(r.ref, r.section, r.date, r.note);
  const cov = Graph.routeCovered(g, parsed.items);
  if (!cov.covered.size) {
    showEdit(`<b>この記録は地図上で特定できません</b><br>${esc(cov.warnings.concat(parsed.errors).join(" / "))}${CLOSE}`);
    return;
  }
  const lines = Graph.splitLines(g, cov.covered).done;
  recActive = id;
  recHighlight = lines;
  selectedRef = r.ref;
  refreshSelection();
  renderRecords();
  const pts = lines.flat();
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  showMap();
  fitVisible([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]]);
  showEdit(`国道${r.ref}号 <b>${esc(r.section)}</b>（${round1(cov.doneKm)} km）を縁取りしています${CLOSE}`);
}

async function saveRecord(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  r.date = $("recDate").value.trim();
  r.note = $("recNote").value.trim();
  await Store.updateRecord(r);
  editingId = null;
  await recompute(r.ref);
  refreshStats();
  render();
  renderRecords();
}

async function deleteRecord(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`国道${r.ref}号「${r.section}」の記録を消します。よろしいですか？`)) return;
  await Store.deleteRecord(id);
  records = records.filter(x => x.id !== id);
  if (recActive === id) { recActive = null; recHighlight = null; }
  await recompute(r.ref);
  refreshSelection();
  refreshStats();
  render();
  renderRecords();
  showEdit(`国道${r.ref}号「${esc(r.section)}」を消しました${CLOSE}`);
}

// ---- CSV の書き出し・読み込み ------------------------------------------------
async function exportText(name, text) {
  const file = new File([text], name, { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;      // やめただけ
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function importCsv(file) {
  const text = await file.text();
  const head = text.slice(0, 200);
  const before = new Set(records.map(r => r.ref));
  if (head.includes("路線番号")) {
    const rows = Store.parseRoutesCsv(text).map(r => ({ ...r, ref: Graph.normRef(r.ref) || r.ref }));
    if (!confirm(`いまの走破記録 ${records.length} 件を、このファイルの ${rows.length} 件で置き換えます。よろしいですか？`)) return;
    await Store.replaceRecords(rows);
    records = await Store.allRecords();
  } else if (head.includes("道の駅")) {
    const rows = Store.parseEkiCsv(text).filter(r => r.date || r.note);
    if (!confirm(`道の駅の訪問記録を、このファイルの ${rows.length} 駅で置き換えます。よろしいですか？`)) return;
    await Store.replaceEkiVisits(rows);
    visits = await Store.ekiVisits();
    EKI.forEach((e, i) => {
      const v = ekiVisit(i);
      ekiMarkers[i].setStyle(ekiStyle(!!(v && v.date)));
      ekiMarkers[i].setPopupContent(ekiPopup(i));
    });
    refreshStats();
    return;
  } else {
    throw new Error("routes.csv か michinoeki.csv を選んでください（見出し行が違います）");
  }
  const refs = new Set([...before, ...records.map(r => r.ref)]);
  let n = 0;
  for (const ref of refs) {
    $("detail").textContent = `計算しています… ${++n}/${refs.size}`;
    await recompute(ref);
  }
  recActive = null; recHighlight = null;
  refreshSelection();
  refreshStats();
  render();
  renderRecords();
  showEdit(`${records.length} 件の記録を読み込みました${CLOSE}`);
}

// ---- 起動 --------------------------------------------------------------------
async function main() {
  // 版を題名に出す。古いキャッシュが配られているかどうかを画面で見分けるため
  document.title = `国道走破マップ v${APP_VERSION}`;
  document.querySelector("h1").textContent = `国道走破マップ v${APP_VERSION}`;
  dbg(`起動 v${APP_VERSION}`);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:" && !PARAMS.has("nosw")) {
    // 新しい sw.js が入って切り替わったら読み直す。切り替わる前に読んだ画面は古いままなので
    // （初回の登録でも controllerchange は起きるが、そのときは読み直さない）
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) location.reload();
    });
    // updateViaCache: "none" … 更新の確認で sw.js と importScripts の version.js を HTTP キャッシュに
    // 通さない。既定（imports）だと古い version.js が返って更新に気づけないことがある
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then(() => dbg("サービスワーカー登録")).catch(err => dbg("サービスワーカー失敗: " + err));
  }

  // 設定の初期値
  let basemap = null;
  try { basemap = localStorage.getItem("basemap"); } catch (err) { /* 無視 */ }
  $("basemap").value = basemap || (navigator.onLine ? "blank" : "none");
  $("basemap").addEventListener("change", () => setBasemap($("basemap").value));
  $("opacity").addEventListener("input", () => { if (baseLayer) baseLayer.setOpacity(Number($("opacity").value) / 100); });
  $("showTodo").addEventListener("change", () => { stackLayers(); refreshSelection(); });
  $("showEki").addEventListener("change", stackLayers);
  $("showNodes").addEventListener("change", drawLabels);
  $("menuBtn").addEventListener("click", () => {
    const open = $("menu").hidden;
    $("menu").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  });
  for (const btn of document.querySelectorAll(".filters button")) {
    btn.addEventListener("click", () => {
      filter = btn.dataset.filter;
      for (const b of document.querySelectorAll(".filters button")) b.setAttribute("aria-pressed", String(b === btn));
      $("list").scrollTop = 0;
      render();
    });
  }
  $("exportRoutes").addEventListener("click", () => exportText("routes.csv", Store.routesCsv(records)).catch(err => showEdit(`<b>書き出せませんでした</b><br>${esc(err.message)}${CLOSE}`)));
  $("exportEki").addEventListener("click", () => exportText("michinoeki.csv", Store.ekiCsv(EKI, visits)).catch(err => showEdit(`<b>書き出せませんでした</b><br>${esc(err.message)}${CLOSE}`)));
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", () => {
    const f = $("importFile").files[0];
    $("importFile").value = "";
    if (f) importCsv(f).catch(err => showEdit(`<b>読み込めませんでした</b><br>${esc(err.message)}${CLOSE}`));
  });

  // データ
  $("detail").textContent = "地図のデータを読んでいます…";
  const [index, lines, nodes, eki] = await Promise.all([
    fetchJson("data/index.json"), fetchJson("data/lines.json"),
    fetchJson("data/nodes.json"), fetchJson("data/eki.json")]);
  INDEX = index; LINES = lines; NODES = nodes; EKI = eki; NAME_SEP = index.nameSep || NAME_SEP;
  for (const r of INDEX.routes) routeIndex.set(r.ref, r);
  buildNodeIndex();
  dbg(`データ読み込み完了: ${INDEX.routes.length} 路線, 地点 ${NODES.length}, 道の駅 ${EKI.length}`);

  [records, visits] = await Promise.all([Store.allRecords(), Store.ekiVisits()]);
  dbg(`記録 ${records.length} 件, 道の駅の訪問 ${visits.size} 件`);

  // 全国の線（未走破として）
  for (const r of INDEX.routes) {
    summary.set(r.ref, baseSummary(r.ref));
    setRouteLines(r.ref, [], (LINES[r.ref] || []).map(Graph.decodeLatLngs));
  }
  buildEki();
  setBasemap($("basemap").value);
  stackLayers();
  sizeLabelCanvas();
  drawLabels();

  // 記録のある路線だけ計算する
  const refs = [...new Set(records.map(r => r.ref))].filter(ref => routeIndex.has(ref));
  let n = 0;
  for (const ref of refs) {
    $("detail").textContent = `走破区間を計算しています… ${++n}/${refs.length}`;
    await recompute(ref);
  }
  refreshStats();
  render();
  renderRecords();
  dbg("起動完了");

  // 「オフライン用に全部保存」
  const about = $("about");
  about.innerHTML = `アプリ v${APP_VERSION}・道路データ ${esc(INDEX.version)} 版・${INDEX.routes.length} 路線<br>` +
    `<button class="btn" type="button" id="cacheAll">全路線を端末に保存（オフライン用）</button><span id="cacheState"></span>`;
  $("cacheAll").addEventListener("click", async () => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) { $("cacheState").textContent = "この開き方では保存できません（https で開いてください）"; return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev) => {
      const d = ev.data;
      $("cacheState").textContent = d.error ? `途中で止まりました（${d.done}/${d.total}）: ${d.error}`
        : d.finished ? `保存しました（${d.total} 路線）` : `保存中 ${d.done}/${d.total}`;
    };
    $("cacheState").textContent = "保存中…";
    sw.postMessage({ type: "cacheAll", urls: INDEX.routes.map(r => `data/routes/r${r.ref}.json`) }, [ch.port2]);
  });
}

main().catch(err => showFatal("起動できませんでした。\n" + (err.stack || err.message || err)));
