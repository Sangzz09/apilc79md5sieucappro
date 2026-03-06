const https = require("https");
const http = require("http");

const SOURCE_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;

let history = [];

// ─── Fetch raw ────────────────────────────────────────────────────────────────
function fetchSource() {
  return new Promise((resolve, reject) => {
    const req = https.get(SOURCE_URL, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, rawText: raw.slice(0, 500), parseError: true }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── Flexible session extractor ───────────────────────────────────────────────
function extractSessions(body) {
  if (!body || typeof body !== "object") return [];
  const candidates = [
    body, body.data, body.result, body.results, body.response,
    body.list, body.items, body.sessions,
    body.data?.sessions, body.data?.list, body.data?.items, body.data?.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  if (body.session_id || body.phien || body.id) return [body];
  return [];
}

// ─── Parse one session ────────────────────────────────────────────────────────
function parseSession(s) {
  if (!s || typeof s !== "object") return null;
  const phien = s.session_id ?? s.sessionId ?? s.phien ?? s.id ?? s.game_id ?? "?";

  let dice = null;
  const diceFields = [
    s.result?.dice, s.dice, s.result?.dices, s.dices,
    s.result?.result, s.detail?.dice, s.data?.dice,
  ];
  for (const f of diceFields) {
    if (Array.isArray(f) && f.length >= 3) {
      const d = f.slice(0, 3).map(Number);
      if (d.every((x) => x >= 1 && x <= 6)) { dice = d; break; }
    }
    if (typeof f === "string") {
      const parts = f.includes(",") ? f.split(",").map(Number) : f.split("").map(Number);
      if (parts.length >= 3 && parts.every((x) => x >= 1 && x <= 6)) { dice = parts.slice(0, 3); break; }
    }
  }
  // Deep search
  if (!dice) {
    for (const key of Object.keys(s)) {
      const val = s[key];
      if (val && typeof val === "object") {
        for (const subkey of Object.keys(val)) {
          const sub = val[subkey];
          if (Array.isArray(sub) && sub.length >= 3 && sub.every((x) => Number(x) >= 1 && Number(x) <= 6)) {
            dice = sub.slice(0, 3).map(Number); break;
          }
        }
        if (dice) break;
      }
    }
  }
  if (!dice) return null;

  const tong = dice.reduce((a, b) => a + b, 0);
  let type = null;
  const txFields = [s.result?.tx, s.tx, s.result?.type, s.type, s.result?.winner, s.winner, s.outcome];
  for (const f of txFields) {
    if (typeof f === "string") {
      const u = f.toUpperCase();
      if (u.includes("T") || u.includes("BIG") || u.includes("TAI")) { type = "T"; break; }
      if (u.includes("X") || u.includes("SMALL") || u.includes("XIU")) { type = "X"; break; }
    }
  }
  if (!type) type = tong >= 11 ? "T" : "X";

  return { phien: String(phien), dice, tong, type };
}

function buildHistory(sessions) {
  return sessions.map(parseSession).filter(Boolean);
}

// ─── Pattern Detection ────────────────────────────────────────────────────────
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.slice(0, 20).join("");

  const streakMatch = s.match(/^(T{3,}|X{3,})/);
  if (streakMatch) {
    const len = streakMatch[0].length;
    return { name: "Bệt " + streakMatch[0][0], pattern: streakMatch[0], next: streakMatch[0][0], conf: Math.min(0.55 + len * 0.04, 0.86) };
  }

  let isAlt = true;
  const altLen = Math.min(seq.length, 8);
  for (let i = 1; i < altLen; i++) { if (seq[i] === seq[i - 1]) { isAlt = false; break; } }
  if (isAlt && altLen >= 4) {
    return { name: "Cầu 1-1", pattern: s.slice(0, altLen), next: seq[0] === "T" ? "X" : "T", conf: 0.72 };
  }

  if (s.length >= 8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[4]===s[0])
    return { name: "Cầu 2-2", pattern: s.slice(0, 8), next: s[0], conf: 0.68 };

  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3])
    return { name: "Cầu 3-3", pattern: s.slice(0, 6), next: s[0], conf: 0.65 };

  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[2]!==s[3] && s[3]===s[4])
    return { name: "Cầu 1-2", pattern: s.slice(0, 6), next: s[0], conf: 0.61 };

  return null;
}

// ─── Algorithms ───────────────────────────────────────────────────────────────
function algoFrequency(seq) {
  const n = Math.min(seq.length, 30);
  const sub = seq.slice(0, n);
  const cntT = sub.filter((x) => x === "T").length;
  const cntX = n - cntT;
  if (cntT / n > 0.62) return { next: "X", conf: 0.52 + (cntT / n - 0.5) * 0.5 };
  if (cntX / n > 0.62) return { next: "T", conf: 0.52 + (cntX / n - 0.5) * 0.5 };
  return null;
}

function algoMarkov(seq) {
  if (seq.length < 10) return null;
  const trans = { T: { T: 0, X: 0 }, X: { T: 0, X: 0 } };
  for (let i = 1; i < seq.length; i++) {
    if (trans[seq[i]] && trans[seq[i]][seq[i - 1]] !== undefined) trans[seq[i]][seq[i - 1]]++;
  }
  const cur = seq[0];
  const toT = trans["T"][cur] || 0;
  const toX = trans["X"][cur] || 0;
  const total = toT + toX;
  if (total < 5) return null;
  if (toT > toX) return { next: "T", conf: 0.5 + (toT / total - 0.5) * 0.6 };
  if (toX > toT) return { next: "X", conf: 0.5 + (toX / total - 0.5) * 0.6 };
  return null;
}

function algoLuong(seq) {
  if (seq.length < 6) return null;
  const w = seq.slice(0, 6);
  let trans = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) trans++;
  if (trans <= 1) return { next: w[0], conf: 0.62 };
  if (trans >= 5) return { next: w[0] === "T" ? "X" : "T", conf: 0.6 };
  return null;
}

function algoDice(hist) {
  if (hist.length < 15) return null;
  const avgSum = hist.slice(0, 15).reduce((a, b) => a + b.tong, 0) / 15;
  if (avgSum < 9.5) return { next: "X", conf: 0.58 };
  if (avgSum > 11.5) return { next: "T", conf: 0.58 };
  return null;
}

function algoStreak5(seq) {
  if (seq.length < 5) return null;
  const last5 = seq.slice(0, 5);
  if (last5.every((x) => x === last5[0])) return { next: last5[0] === "T" ? "X" : "T", conf: 0.63 };
  return null;
}

// ─── Ensemble ─────────────────────────────────────────────────────────────────
function predict(hist) {
  if (hist.length < 5) return { next: "?", conf: 0, cauType: "Chưa đủ dữ liệu", pattern: "" };
  const seq = hist.map((h) => h.type);
  const weights = { T: 0, X: 0 };
  const votes = { T: 0, X: 0 };

  const add = (algo, w) => {
    if (!algo) return;
    votes[algo.next] += w;
    weights[algo.next] += algo.conf * w;
  };

  const pat = detectPattern(seq);
  add(pat, 3);
  add(algoFrequency(seq), 2);
  add(algoMarkov(seq), 2);
  add(algoLuong(seq), 1);
  add(algoDice(hist), 1);
  add(algoStreak5(seq), 1);

  const totalT = weights["T"] || 0;
  const totalX = weights["X"] || 0;
  const total = totalT + totalX;

  let next = "T", finalConf = 0.5;
  if (total > 0) {
    if (totalT >= totalX) { next = "T"; finalConf = totalT / total; }
    else { next = "X"; finalConf = totalX / total; }
  }

  const patternStr = seq.slice(0, 12).join("");
  const cauType = pat ? pat.name : votes["T"] > votes["X"] ? "Nghiêng Tài" : votes["X"] > votes["T"] ? "Nghiêng Xỉu" : "Lộn Xộn";

  return { next: next === "T" ? "Tài" : "Xỉu", conf: Math.round(Math.min(finalConf, 0.92) * 100), cauType, pattern: patternStr };
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
let lastDebug = null;

async function syncHistory() {
  try {
    const result = await fetchSource();
    lastDebug = result;
    if (result.parseError) return;
    const sessions = extractSessions(result.body);
    if (!sessions.length) return;
    const parsed = buildHistory(sessions);
    const existing = new Set(history.map((h) => h.phien));
    for (const item of parsed) {
      if (!existing.has(item.phien)) history.unshift(item);
    }
    if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  } catch (_) {}
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();
    if (history.length === 0) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu", hint: "Truy cập /debug để kiểm tra JSON nguồn" }));
      return;
    }
    const latest = history[0];
    const pred = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien: latest.phien,
      xuc_xac: latest.dice,
      phien_hien_tai: latest.phien,
      du_doan: pred.next,
      do_tin_cay: pred.conf + "%",
      loai_cau: pred.cauType,
      pattern: pred.pattern,
    }));
    return;
  }

  if (url.pathname === "/history") {
    await syncHistory();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data: history.slice(0, limit).map((h) => ({
        phien: h.phien, xuc_xac: h.dice, tong: h.tong, ket_qua: h.type === "T" ? "Tài" : "Xỉu",
      })),
    }));
    return;
  }

  // /debug — xem raw response từ nguồn để tìm cấu trúc JSON
  if (url.pathname === "/debug") {
    const result = await fetchSource().catch((e) => ({ error: e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));

}).listen(PORT, () => {
  console.log("API running on port " + PORT);
  syncHistory();
  setInterval(syncHistory, 15000);
});
