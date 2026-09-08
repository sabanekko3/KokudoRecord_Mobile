// 区間の指定を「走破した辺の集合」に直す計算。PC 版（kokudo_map.py）の
// RouteGraph / parse_section / route_covered / route_features の移植。
// DOM には触らない。app.js から使う。
//
// ノードの識別は座標そのもの（1e-7 度単位の整数）。PC 版の node_key と同じ丸めなので、
// 同じ OSM ノードは必ず同じキーになり、路線をまたいでも辺の集合の和が取れる。
// JS の整数は 53 ビットまでなので、PC 版のように 1 つの整数には詰めず "x,y" の文字列にする。
"use strict";

const Graph = (() => {
  const FULL = "全線";
  const SEP_RE = /[〜～~－―\-–—→]/;
  // 「@37.4056,138.8087」のように座標で区間端を書く形（/ 区切りでもよい）
  const COORD_ONLY_RE = /^@?\s*(\d+(?:\.\d+)?)\s*[,/]\s*(\d+(?:\.\d+)?)\s*$/;
  const SCALE = 1e7;
  const LON_OFFSET = 1800000000;
  const LAT_OFFSET = 900000000;
  const KIND_PLAIN = 0;

  // 交差点名の表記ゆれを吸収する（「長沢（西）」と「長沢(西)」、全角空白）
  function normName(text) {
    return String(text).normalize("NFKC").replace(/[ 　]/g, "");
  }

  function lonlatToXY(lon, lat) {
    return [Math.round((lon + 180) * SCALE) - LON_OFFSET,
            Math.round((lat + 90) * SCALE) - LAT_OFFSET];
  }

  function xyToLatLng(x, y) {
    return [y / SCALE, x / SCALE];
  }

  // 2点間の距離 [km]。PC 版の _add_ways と同じ式（ハバーサイン）
  function kmXY(ax, ay, bx, by) {
    const rad = Math.PI / 180 / SCALE;
    const p1 = ay * rad, p2 = by * rad;
    const s1 = Math.sin((p2 - p1) / 2), s2 = Math.sin((bx - ax) * rad / 2);
    const h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 12742.0 * Math.asin(Math.sqrt(h));
  }

  function nodeKey(x, y) {
    return x + "," + y;
  }

  // 向きに依存しない辺のキー。(経度, 緯度) の辞書順で並べる（PC 版と同じ向き）
  function edgeKey(ax, ay, bx, by) {
    return (ax < bx || (ax === bx && ay < by))
      ? ax + "," + ay + "|" + bx + "," + by
      : bx + "," + by + "|" + ax + "," + ay;
  }

  // 書き出しの差分整数列 [x0, y0, dx1, dy1, ...] → [[x, y], ...]
  function decodeWay(flat) {
    const out = new Array(flat.length / 2);
    let x = 0, y = 0;
    for (let i = 0, j = 0; i < flat.length; i += 2, j++) {
      x += flat[i];
      y += flat[i + 1];
      out[j] = [x, y];
    }
    return out;
  }

  // 差分整数列の線 → Leaflet 用の [[緯度, 経度], ...]
  function decodeLatLngs(flat) {
    const out = new Array(flat.length / 2);
    let x = 0, y = 0;
    for (let i = 0, j = 0; i < flat.length; i += 2, j++) {
      x += flat[i];
      y += flat[i + 1];
      out[j] = [y / SCALE, x / SCALE];
    }
    return out;
  }

  // 小さな二分ヒープ（Dijkstra 用）。要素は [距離, ノードキー]
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(item) {
      const a = this.a;
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p][0] <= a[i][0]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  // 1路線の道路網。data/routes/r{ref}.json から組む
  class RouteGraph {
    constructor(data) {
      this.ref = data.ref;
      this.km = data.km;
      this.bounds = data.bounds;
      this.ways = data.ways.map(decodeWay);
      this.keep = data.keep;
      this.points = data.points.map(p => ({ name: p[0], lat: p[1], lon: p[2], kind: p[3], km: p[4] }));
      this.adj = new Map();      // ノードキー → [[隣のキー, km, 辺のキー], ...]
      this.edges = new Map();    // 辺のキー → km
      this.xy = new Map();       // ノードキー → [x, y]
      for (const way of this.ways) {
        for (let i = 0; i < way.length - 1; i++) {
          const [ax, ay] = way[i], [bx, by] = way[i + 1];
          if (ax === bx && ay === by) continue;
          this._link(ax, ay, bx, by);
        }
      }
      // 形状には無いが導出時に繋いだ辺（隙間の橋渡し）
      for (const [ax, ay, bx, by] of data.bridges || []) this._link(ax, ay, bx, by);
    }

    _link(ax, ay, bx, by) {
      const key = edgeKey(ax, ay, bx, by);
      if (this.edges.has(key)) return;
      const d = kmXY(ax, ay, bx, by);
      this.edges.set(key, d);
      const a = nodeKey(ax, ay), b = nodeKey(bx, by);
      let la = this.adj.get(a);
      if (!la) { this.adj.set(a, la = []); this.xy.set(a, [ax, ay]); }
      let lb = this.adj.get(b);
      if (!lb) { this.adj.set(b, lb = []); this.xy.set(b, [bx, by]); }
      la.push([b, d, key]);
      lb.push([a, d, key]);
    }

    // 指定座標に対応するノード。交差点は道路の構成点なので通常は完全一致する
    nearest(lon, lat) {
      const [x0, y0] = lonlatToXY(lon, lat);
      const exact = nodeKey(x0, y0);
      if (this.adj.has(exact)) return exact;
      let best = null, bestD = Infinity;
      for (const [key, [x, y]] of this.xy) {
        const dx = x - x0, dy = (y - y0) * 1.2;   // 緯度方向を伸ばしておおむね等方に
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = key; }
      }
      return best;
    }

    dijkstra(start, goal) {
      const dist = new Map([[start, 0]]);
      const prev = new Map();
      const pq = new Heap();
      pq.push([0, start]);
      while (pq.size) {
        const [d, u] = pq.pop();
        if (d > dist.get(u)) continue;
        if (u === goal) break;
        for (const [v, w, key] of this.adj.get(u)) {
          const nd = d + w;
          const old = dist.get(v);
          if (old === undefined || nd < old) {
            dist.set(v, nd);
            prev.set(v, [u, key]);
            pq.push([nd, v]);
          }
        }
      }
      return [dist, prev];
    }

    // start → goal の最短経路が通る辺の集合と距離
    pathEdges(start, goal) {
      const [dist, prev] = this.dijkstra(start, goal);
      if (!dist.has(goal)) return [null, null];
      const edges = new Set();
      let cur = goal;
      while (cur !== start) {
        const [p, key] = prev.get(cur);
        edges.add(key);
        cur = p;
      }
      return [edges, dist.get(goal)];
    }

    // 2つのノードが同じ連結成分にあるか（経路が無いときの説明用）
    connected(a, b) {
      const seen = new Set([a]);
      const stack = [a];
      while (stack.length) {
        const u = stack.pop();
        if (u === b) return true;
        for (const [v] of this.adj.get(u)) {
          if (!seen.has(v)) { seen.add(v); stack.push(v); }
        }
      }
      return false;
    }
  }

  // ---- 区間の解釈 ----------------------------------------------------------

  // 区間欄の1項目 → {kind: "full"} / {kind: "nodes", a, b, label} / null
  function parseSection(text) {
    text = String(text).trim();
    if (!text || text === FULL) return { kind: "full" };
    const parts = text.split(SEP_RE).map(s => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { kind: "nodes", a: parts[0], b: parts[1], label: text };
    }
    return null;
  }

  // 路線番号の表記ゆれ（R17、国道17号）を数字だけにする
  function normRef(raw) {
    const s = String(raw || "").trim().replace(/^[Rr]/, "").replace(/^国道/, "").replace(/号$/, "").trim();
    return /^\d+$/.test(s) ? s : null;
  }

  // routes.csv の1行 → 区間指定の並び。都道府県指定はこの版では扱わない
  function parseRow(rawRef, rawSection, date, note) {
    const ref = normRef(rawRef);
    const errors = [];
    if (!ref) return { ref: null, items: [], errors: [`路線番号「${rawRef}」を読めません`] };
    const text = String(rawSection || FULL).trim() || FULL;
    const items = SEP_RE.test(text)
      ? [text]
      : text.replace(/・/g, "/").split("/").map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const item of items) {
      const sec = parseSection(item);
      if (!sec) {
        errors.push(`区間「${item}」はこの版では使えません（全線か「A〜B」の形で書いてください）`);
        continue;
      }
      out.push(Object.assign(sec, { ref, date: date || "", note: note || "" }));
    }
    return { ref, items: out, errors };
  }

  // ---- 区間端の解決 --------------------------------------------------------

  // 交差点名の候補。「本町@104.6」はキロ程で、「本町@37.4,138.8」は座標で絞る
  function matchNamedNodes(points, query) {
    let q = query.trim(), hint = null;
    const at = q.indexOf("@");
    if (at >= 0) { hint = q.slice(at + 1).trim(); q = q.slice(0, at).trim(); }

    const variants = [normName(q), normName(q.replace(/交差点/g, ""))];
    const names = points.map(p => [p, normName(p.name)]);
    let hits = [];
    for (const v of variants) {
      hits = names.filter(([, nm]) => nm === v).map(([p]) => p);
      if (hits.length) break;
    }
    if (!hits.length) {
      for (const v of variants) {
        hits = v ? names.filter(([, nm]) => nm.includes(v)).map(([p]) => p) : [];
        if (hits.length) break;
      }
    }
    if (!hits.length || !hint) return hits;

    if (hint.includes(",") || hint.includes("/")) {
      const m = hint.split(/[,/]/);
      const lat = parseFloat(m[0]), lon = parseFloat(m[1]);
      if (isNaN(lat) || isNaN(lon)) return hits;
      let best = hits[0], bestD = Infinity;
      for (const p of hits) {
        const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
      return [best];
    }
    const target = parseFloat(hint.replace(/[kmKM]+$/, ""));
    if (isNaN(target)) return hits;
    let best = hits[0], bestD = Infinity;
    for (const p of hits) {
      const d = Math.abs((p.km === null || p.km === undefined ? 1e9 : p.km) - target);
      if (d < bestD) { bestD = d; best = p; }
    }
    return [best];
  }

  function endpointCandidates(points, text) {
    const m = COORD_ONLY_RE.exec(text.trim());
    if (m) {
      return [{ name: text.trim(), lat: parseFloat(m[1]), lon: parseFloat(m[2]), kind: KIND_PLAIN }];
    }
    return matchNamedNodes(points, text);
  }

  // 「A〜B」→ [辺の集合, 距離] か [null, 理由]
  function resolveNodeSection(graph, sec) {
    const candA = endpointCandidates(graph.points, sec.a);
    const candB = endpointCandidates(graph.points, sec.b);
    for (const [name, cands] of [[sec.a, candA], [sec.b, candB]]) {
      if (!cands.length) {
        return [null, `地点「${name}」が見つかりません。地図で名前を確かめるか、@緯度/経度 の形で書いてください`];
      }
    }
    // 候補が複数あるときは、経路がいちばん短くなる組み合わせを採る
    let best = null;
    for (const na of candA) {
      const ka = graph.nearest(na.lon, na.lat);
      for (const nb of candB) {
        const kb = graph.nearest(nb.lon, nb.lat);
        if (ka === kb) continue;
        const [edges, dist] = graph.pathEdges(ka, kb);
        if (edges && (best === null || dist < best[1])) best = [edges, dist];
      }
    }
    if (!best) {
      const ka = graph.nearest(candA[0].lon, candA[0].lat);
      const kb = graph.nearest(candB[0].lon, candB[0].lat);
      const why = (ka === kb) ? "2点が同じ場所を指しています"
        : graph.connected(ka, kb) ? "経路が見つかりません"
        : "2点は別々のかたまりに属しています（海上区間や未開通区間で分断されている可能性があります）";
      return [null, `「${sec.label}」を繋げません。${why}`];
    }
    return best;
  }

  // 1路線の記録 → 走破した辺の集合と表示用の情報
  function routeCovered(graph, secs) {
    const covered = new Set();
    const sections = [], dates = [], notes = [], warnings = [];
    for (const sec of secs) {
      if (sec.date) dates.push(sec.date);
      if (sec.note) notes.push(sec.note);
      if (sec.kind === "full") {
        for (const key of graph.edges.keys()) covered.add(key);
        sections.push(FULL);
      } else if (sec.kind === "nodes") {
        const [edges, dist] = resolveNodeSection(graph, sec);
        if (edges) {
          for (const key of edges) covered.add(key);
          sections.push(`${sec.label}（${dist.toFixed(0)} km）`);
        } else {
          warnings.push(dist);
        }
      }
    }
    let doneKm = 0;
    for (const key of covered) doneKm += graph.edges.get(key);
    return { covered, doneKm, sections, dates: [...new Set(dates)].sort(), notes, warnings };
  }

  function routeStatus(km, doneKm, covered) {
    if (!covered.size) return "todo";
    return doneKm >= km * 0.98 ? "done" : "partial";
  }

  // 各 way を走破／未走破の連続部分に切り分ける。間引きは導出時の印（keep）を使う
  function splitLines(graph, covered) {
    const done = [], todo = [];
    const cut = (way, keep, s, e, into) => {
      const line = [xyToLatLng(way[s][0], way[s][1])];
      for (let i = s + 1; i < e; i++) {
        if (keep.charCodeAt(i) === 49) line.push(xyToLatLng(way[i][0], way[i][1]));   // "1"
      }
      line.push(xyToLatLng(way[e][0], way[e][1]));
      into.push(line);
    };
    graph.ways.forEach((way, w) => {
      const n = way.length;
      if (n < 2) return;
      const keep = graph.keep[w];
      let start = 0, state = null;
      for (let i = 0; i < n - 1; i++) {
        const [ax, ay] = way[i], [bx, by] = way[i + 1];
        if (ax === bx && ay === by) continue;
        const hit = covered.has(edgeKey(ax, ay, bx, by));
        if (hit === state) continue;
        if (state !== null) cut(way, keep, start, i, state ? done : todo);
        start = i;
        state = hit;
      }
      if (state !== null) cut(way, keep, start, n - 1, state ? done : todo);
    });
    return { done, todo };
  }

  return { FULL, SEP_RE, RouteGraph, normName, normRef, parseSection, parseRow,
           routeCovered, routeStatus, splitLines, decodeLatLngs, matchNamedNodes };
})();
