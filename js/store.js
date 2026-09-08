// 記録の保存（IndexedDB）と、routes.csv / michinoeki.csv との相互変換。
// CSV の形式は PC 版とまったく同じにしてあるので、書き出したものは PC 版がそのまま読める。
"use strict";

const Store = (() => {
  const DB_NAME = "kokudo";
  const DB_VERSION = 1;
  const ROUTE_HEADER = ["路線番号", "区間", "走破日", "メモ"];
  const EKI_HEADER = ["都道府県", "道の駅", "訪問日", "メモ"];
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("records")) {
          db.createObjectStore("records", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("eki")) {
          db.createObjectStore("eki", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r && typeof r.onsuccess !== "undefined") r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  // ---- 走破記録 ------------------------------------------------------------
  // {id, ref, section, date, note}。id の順が routes.csv の行の順
  function allRecords() {
    return tx("records", "readonly", s => s.getAll());
  }
  function addRecord(rec) {
    return tx("records", "readwrite", s => s.add({ ref: rec.ref, section: rec.section,
                                                   date: rec.date || "", note: rec.note || "" }));
  }
  function updateRecord(rec) {
    return tx("records", "readwrite", s => s.put(rec));
  }
  function deleteRecord(id) {
    return tx("records", "readwrite", s => s.delete(id));
  }
  function replaceRecords(list) {
    return tx("records", "readwrite", s => {
      s.clear();
      for (const rec of list) s.add({ ref: rec.ref, section: rec.section, date: rec.date || "", note: rec.note || "" });
    });
  }

  // ---- 道の駅 --------------------------------------------------------------
  // キーは 県|駅名（同名の駅が県をまたいで実在する）
  function ekiKey(pref, name) { return pref + "|" + name; }
  function ekiVisits() {
    return tx("eki", "readonly", s => s.getAll()).then(rows => {
      const m = new Map();
      for (const r of rows) m.set(r.key, r);
      return m;
    });
  }
  function setEkiVisit(pref, name, date, note) {
    const key = ekiKey(pref, name);
    return tx("eki", "readwrite", s => s.put({ key, pref, name, date: date || "", note: note || "" }));
  }
  function replaceEkiVisits(list) {
    return tx("eki", "readwrite", s => {
      s.clear();
      for (const r of list) s.put({ key: ekiKey(r.pref, r.name), pref: r.pref, name: r.name,
                                    date: r.date || "", note: r.note || "" });
    });
  }

  // ---- CSV -----------------------------------------------------------------
  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // 引用符付きの欄と欄内の改行に対応した CSV の読み取り → 行ごとの欄の並び
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], cur = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
        } else cur += c;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ",") {
        row.push(cur); cur = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // 見出し行を使って {列名: 値} の並びにする
  function parseTable(text, header) {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const head = rows[0].map(s => s.trim());
    const idx = header.map(h => head.indexOf(h));
    if (idx[0] < 0) throw new Error(`見出し行に「${header[0]}」がありません。${header.join("、")} の順の CSV を選んでください`);
    const out = [];
    for (const r of rows.slice(1)) {
      if (!r.some(v => v.trim())) continue;
      const obj = {};
      header.forEach((h, j) => { obj[h] = idx[j] >= 0 ? (r[idx[j]] || "").trim() : ""; });
      out.push(obj);
    }
    return out;
  }

  // routes.csv の中身（BOM 付き UTF-8・LF。PC 版と同じ）
  function routesCsv(records) {
    const lines = [ROUTE_HEADER.join(",")];
    for (const r of records) lines.push([r.ref, r.section, r.date, r.note].map(csvCell).join(","));
    return "﻿" + lines.join("\n") + "\n";
  }

  function parseRoutesCsv(text) {
    return parseTable(text, ROUTE_HEADER).map(o => ({
      ref: o["路線番号"], section: o["区間"], date: o["走破日"], note: o["メモ"] }));
  }

  // michinoeki.csv の中身。全駅を並べ、訪問した駅に日付を入れる（PC 版の sync_eki_csv と同じ形）
  function ekiCsv(stations, visits) {
    const lines = [EKI_HEADER.join(",")];
    const listed = new Set();
    for (const s of stations) {           // [緯度, 経度, 名前, 都道府県]
      const v = visits.get(ekiKey(s[3], s[2]));
      listed.add(ekiKey(s[3], s[2]));
      lines.push([s[3], s[2], v ? v.date : "", v ? v.note : ""].map(csvCell).join(","));
    }
    for (const v of visits.values()) {    // 一覧に無い駅の記録も残す
      if (!listed.has(v.key)) lines.push([v.pref, v.name, v.date, v.note].map(csvCell).join(","));
    }
    return "﻿" + lines.join("\n") + "\n";
  }

  // PC 版の eki_name() と同じ正規化
  function ekiName(name) {
    const n = String(name).normalize("NFKC").replace(/[ 　]/g, "");
    return n.startsWith("道の駅") ? n.slice(3) : n;
  }

  function parseEkiCsv(text) {
    return parseTable(text, EKI_HEADER)
      .filter(o => o["道の駅"])
      .map(o => ({ pref: o["都道府県"], name: ekiName(o["道の駅"]), date: o["訪問日"], note: o["メモ"] }));
  }

  return { allRecords, addRecord, updateRecord, deleteRecord, replaceRecords,
           ekiVisits, setEkiVisit, replaceEkiVisits, ekiKey, ekiName,
           routesCsv, parseRoutesCsv, ekiCsv, parseEkiCsv, parseCsv };
})();
