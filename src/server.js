const https = require("https");
const http = require("http");

const SOURCE_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;

// ─── Data Store ───────────────────────────────────────────────────────────────
let history = []; // [{phien, result: [d1,d2,d3], tong, loai}]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fetchSource() {
  return new Promise((resolve, reject) => {
    https
      .get(SOURCE_URL, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function classify(tong) {
  // Tài = 11-18, Xỉu = 3-10
  return tong >= 11 ? "T" : "X";
}

function buildHistory(sessions) {
  const arr = [];
  for (const s of sessions) {
    if (!s.result || !Array.isArray(s.result.dice)) continue;
    const dice = s.result.dice.slice(0, 3);
    if (dice.length < 3) continue;
    const tong = dice.reduce((a, b) => a + b, 0);
    arr.push({
      phien: s.session_id ?? s.id ?? s.phien,
      dice,
      tong,
      type: classify(tong),
    });
  }
  return arr.reverse(); // oldest → newest
}

// ─── Pattern Detection ────────────────────────────────────────────────────────
function detectPattern(seq) {
  // seq = array of "T"/"X" newest first
  const s = seq.slice(0, 20).join("");

  // 1. Streak (cầu bệt)
  const streakMatch = s.match(/^(T+|X+)/);
  if (streakMatch && streakMatch[0].length >= 3) {
    return {
      name: "Bệt",
      pattern: streakMatch[0],
      next: streakMatch[0][0],
      conf: Math.min(0.55 + streakMatch[0].length * 0.04, 0.85),
    };
  }

  // 2. Alternating 1-1 (cầu 1-1)
  const alt = s.slice(0, 8);
  let isAlt = true;
  for (let i = 1; i < alt.length; i++) {
    if (alt[i] === alt[i - 1]) {
      isAlt = false;
      break;
    }
  }
  if (isAlt && alt.length >= 4) {
    const next = alt[0] === "T" ? "X" : "T";
    return { name: "Cầu 1-1", pattern: alt, next, conf: 0.72 };
  }

  // 3. 2-2 pattern
  if (
    s.length >= 8 &&
    s[0] === s[1] &&
    s[2] === s[3] &&
    s[0] !== s[2] &&
    s[4] === s[5] &&
    s[4] === s[0]
  ) {
    const next = s[0] === s[1] ? s[0] : s[2];
    return { name: "Cầu 2-2", pattern: s.slice(0, 8), next, conf: 0.68 };
  }

  // 4. 3-3 pattern
  if (
    s.length >= 6 &&
    s[0] === s[1] &&
    s[1] === s[2] &&
    s[3] === s[4] &&
    s[4] === s[5] &&
    s[0] !== s[3]
  ) {
    const next = s[0];
    return { name: "Cầu 3-3", pattern: s.slice(0, 6), next, conf: 0.65 };
  }

  // 5. TXTX / XTXT cầu xen kẽ nhóm
  const rep2 = s.slice(0, 6);
  if (rep2 === "TXTXTX" || rep2 === "XTXTXT") {
    const next = rep2[0] === "T" ? "X" : "T";
    return { name: "Xen Kẽ", pattern: rep2, next, conf: 0.7 };
  }

  return null;
}

// ─── Statistical Algorithms ───────────────────────────────────────────────────
function algoFrequency(seq) {
  const n = Math.min(seq.length, 30);
  const sub = seq.slice(0, n);
  const cntT = sub.filter((x) => x === "T").length;
  const cntX = n - cntT;
  // Regression to mean
  if (cntT / n > 0.6)
    return { next: "X", conf: 0.55 + (cntT / n - 0.5) * 0.4 };
  if (cntX / n > 0.6)
    return { next: "T", conf: 0.55 + (cntX / n - 0.5) * 0.4 };
  return null;
}

function algoMarkov(seq) {
  if (seq.length < 10) return null;
  // Build 2nd order Markov
  const trans = { TT: { T: 0, X: 0 }, TX: { T: 0, X: 0 }, XT: { T: 0, X: 0 }, XX: { T: 0, X: 0 } };
  for (let i = 2; i < seq.length; i++) {
    const key = seq[i - 1] + seq[i - 2];
    if (trans[key]) trans[key][seq[i - (i > 0 ? 0 : 0)]] = (trans[key][seq[i - (i > 0 ? 0 : 0)]] || 0);
  }
  // Simplified: 1st order
  const trans1 = { T: { T: 0, X: 0 }, X: { T: 0, X: 0 } };
  for (let i = 1; i < seq.length; i++) {
    trans1[seq[i]][seq[i - 1]] = (trans1[seq[i]][seq[i - 1]] || 0) + 1;
  }
  const cur = seq[0];
  const toT = trans1["T"][cur] || 0;
  const toX = trans1["X"][cur] || 0;
  const total = toT + toX;
  if (total < 5) return null;
  if (toT > toX) return { next: "T", conf: 0.5 + (toT / total - 0.5) * 0.6 };
  if (toX > toT) return { next: "X", conf: 0.5 + (toX / total - 0.5) * 0.6 };
  return null;
}

function algoLuong(seq) {
  // Detect "sóng" - wave pattern
  if (seq.length < 6) return null;
  const w = seq.slice(0, 6);
  // Count transitions
  let trans = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) trans++;
  if (trans <= 1) return { next: w[0], conf: 0.62 }; // strong streak
  if (trans >= 5) return { next: w[0] === "T" ? "X" : "T", conf: 0.6 }; // heavy alternating
  return null;
}

function algoDice(hist) {
  // Analyze raw dice sum distribution
  if (hist.length < 15) return null;
  const recent = hist.slice(0, 15);
  const avgSum = recent.reduce((a, b) => a + b.tong, 0) / recent.length;
  // If avg sum trending low → bias Xỉu, high → Tài
  if (avgSum < 9.5) return { next: "X", conf: 0.58 };
  if (avgSum > 11.5) return { next: "T", conf: 0.58 };
  return null;
}

// ─── Ensemble Predictor ───────────────────────────────────────────────────────
function predict(hist) {
  if (hist.length < 5) return { next: "?", conf: 0, cauType: "Chưa đủ dữ liệu", pattern: "" };

  const seq = hist.map((h) => h.type); // newest first

  const votes = { T: 0, X: 0 };
  const weights = { T: 0, X: 0 };
  const details = [];

  // Pattern detection (weight 3)
  const pat = detectPattern(seq);
  if (pat) {
    votes[pat.next] += 3;
    weights[pat.next] += pat.conf * 3;
    details.push({ src: pat.name, next: pat.next, conf: pat.conf });
  }

  // Frequency analysis (weight 2)
  const freq = algoFrequency(seq);
  if (freq) {
    votes[freq.next] += 2;
    weights[freq.next] += freq.conf * 2;
    details.push({ src: "Tần suất", next: freq.next, conf: freq.conf });
  }

  // Markov chain (weight 2)
  const markov = algoMarkov(seq);
  if (markov) {
    votes[markov.next] += 2;
    weights[markov.next] += markov.conf * 2;
    details.push({ src: "Markov", next: markov.next, conf: markov.conf });
  }

  // Luồng sóng (weight 1)
  const luong = algoLuong(seq);
  if (luong) {
    votes[luong.next] += 1;
    weights[luong.next] += luong.conf;
    details.push({ src: "Sóng", next: luong.next, conf: luong.conf });
  }

  // Dice distribution (weight 1)
  const dice = algoDice(hist);
  if (dice) {
    votes[dice.next] += 1;
    weights[dice.next] += dice.conf;
    details.push({ src: "Xúc Xắc", next: dice.next, conf: dice.conf });
  }

  const totalT = weights["T"] || 0;
  const totalX = weights["X"] || 0;

  let next, finalConf;
  if (totalT === 0 && totalX === 0) {
    next = Math.random() > 0.5 ? "T" : "X";
    finalConf = 0.5;
  } else {
    const total = totalT + totalX;
    if (totalT >= totalX) {
      next = "T";
      finalConf = totalT / total;
    } else {
      next = "X";
      finalConf = totalX / total;
    }
  }

  const patternStr = seq.slice(0, 10).join("");

  let cauType = "Lộn Xộn";
  if (pat) cauType = pat.name;
  else if (votes["T"] > votes["X"]) cauType = "Nghiêng Tài";
  else if (votes["X"] > votes["T"]) cauType = "Nghiêng Xỉu";

  return {
    next: next === "T" ? "Tài" : "Xỉu",
    conf: Math.round(Math.min(finalConf, 0.92) * 100),
    cauType,
    pattern: patternStr,
    detail: details,
  };
}

// ─── Sync History ─────────────────────────────────────────────────────────────
async function syncHistory() {
  try {
    const data = await fetchSource();
    // Support various response shapes
    const sessions =
      data.data?.sessions ??
      data.sessions ??
      data.data ??
      (Array.isArray(data) ? data : []);
    if (!sessions.length) return;
    const parsed = buildHistory(sessions);
    // Merge new entries
    const existing = new Set(history.map((h) => String(h.phien)));
    for (const item of parsed) {
      if (!existing.has(String(item.phien))) history.unshift(item);
    }
    // Keep most recent HISTORY_LIMIT
    if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  } catch (e) {
    // silently skip
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);

  // ── GET /predict ──────────────────────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();

    if (history.length === 0) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
      return;
    }

    const latest = history[0];
    const pred = predict(history);

    const out = {
      phien: latest.phien,
      xuc_xac: latest.dice,
      phien_hien_tai: String(latest.phien),
      du_doan: pred.next,
      do_tin_cay: `${pred.conf}%`,
      loai_cau: pred.cauType,
      pattern: pred.pattern,
    };

    res.writeHead(200);
    res.end(JSON.stringify(out));
    return;
  }

  // ── GET /history ──────────────────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const rows = history.slice(0, limit).map((h) => ({
      phien: h.phien,
      xuc_xac: h.dice,
      tong: h.tong,
      ket_qua: h.type === "T" ? "Tài" : "Xỉu",
    }));
    res.writeHead(200);
    res.end(JSON.stringify({ total: rows.length, data: rows }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  console.log(`  GET /predict  → dự đoán phiên tiếp theo`);
  console.log(`  GET /history  → lịch sử gần nhất`);
});

// Auto-sync every 15 seconds
setInterval(syncHistory, 15000);
syncHistory();
