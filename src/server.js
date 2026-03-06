const https = require("https");
const http  = require("http");

const SOURCE_URL   = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT         = process.env.PORT || 3000;
const HISTORY_MAX  = 300;

let history = []; // [{phien, dice, tong, type:"T"|"X"}]  newest → oldest

// ══════════════════════════════════════════════════════════════
//  FETCH
// ══════════════════════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const req = https.get(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try   { resolve({ ok: true,  body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw: raw.slice(0, 800) }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ══════════════════════════════════════════════════════════════
//  PARSE
// ══════════════════════════════════════════════════════════════
function extractSessions(body) {
  if (!body || typeof body !== "object") return [];
  const paths = [
    body, body.data, body.result, body.results, body.response,
    body.list, body.items, body.sessions,
    body.data?.sessions, body.data?.list, body.data?.items, body.data?.data,
  ];
  for (const p of paths) if (Array.isArray(p) && p.length) return p;
  if (body.session_id || body.phien || body.id) return [body];
  return [];
}

function findDice(s) {
  const tryCast = (arr) => {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const d = arr.slice(0, 3).map(Number);
    return d.every(x => x >= 1 && x <= 6) ? d : null;
  };
  const strParse = (f) => {
    if (typeof f !== "string") return null;
    const parts = f.includes(",") ? f.split(",").map(Number) : f.split("").map(Number);
    return parts.length >= 3 && parts.every(x => x >= 1 && x <= 6) ? parts.slice(0,3) : null;
  };

  const fields = [
    s.result?.dice, s.dice, s.result?.dices, s.dices,
    s.result?.result, s.detail?.dice, s.data?.dice,
    s.result?.numbers, s.numbers,
  ];
  for (const f of fields) {
    const d = tryCast(f) || strParse(f);
    if (d) return d;
  }
  // deep scan one level
  for (const key of Object.keys(s)) {
    const val = s[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const sub of Object.values(val)) {
        const d = tryCast(sub);
        if (d) return d;
      }
    }
  }
  return null;
}

function parseSession(s) {
  if (!s || typeof s !== "object") return null;
  const phien = String(s.session_id ?? s.sessionId ?? s.phien ?? s.id ?? s.game_id ?? "?");
  const dice  = findDice(s);
  if (!dice) return null;

  const tong  = dice.reduce((a,b) => a+b, 0);

  // Try explicit TX field
  let type = null;
  const txCandidates = [
    s.result?.tx, s.tx, s.result?.type, s.type,
    s.result?.winner, s.winner, s.outcome, s.result?.outcome,
    s.result?.label, s.label,
  ];
  for (const f of txCandidates) {
    if (typeof f === "string") {
      const u = f.toUpperCase();
      if (/^(T|TAI|BIG|OVER|LO)/.test(u))  { type = "T"; break; }
      if (/^(X|XIU|SMALL|UNDER|HI)/.test(u)) { type = "X"; break; }
    }
    if (typeof f === "number") { type = f >= 11 ? "T" : "X"; break; }
  }
  if (!type) type = tong >= 11 ? "T" : "X";

  return { phien, dice, tong, type };
}

function ingest(sessions) {
  const existing = new Set(history.map(h => h.phien));
  const parsed   = sessions.map(parseSession).filter(Boolean);

  // Sort by phien desc (newest first) then merge
  parsed.sort((a,b) => Number(b.phien) - Number(a.phien));
  for (const item of parsed) {
    if (!existing.has(item.phien)) {
      history.push(item);
      existing.add(item.phien);
    }
  }
  // Keep sorted newest first, cap size
  history.sort((a,b) => Number(b.phien) - Number(a.phien));
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
}

// ══════════════════════════════════════════════════════════════
//  SELF-CALIBRATING ACCURACY TRACKER
// ══════════════════════════════════════════════════════════════
// Tracks each algo's rolling accuracy over last 50 calls
const ALGO_NAMES = ["pattern","markov2","markov1","freq","luong","dice","streak5","entropy"];
const algoAcc = {};
for (const n of ALGO_NAMES) algoAcc[n] = { correct: 20, total: 40 }; // start 50% prior

function updateAlgoAcc(name, predicted, actual) {
  if (!algoAcc[name]) return;
  algoAcc[name].total++;
  if (predicted === actual) algoAcc[name].correct++;
  // decay window ~50
  if (algoAcc[name].total > 50) {
    algoAcc[name].correct *= 50 / algoAcc[name].total;
    algoAcc[name].total    = 50;
  }
}

function getAlgoWeight(name) {
  const a = algoAcc[name];
  if (!a || a.total < 5) return 1.0;
  const acc = a.correct / a.total;
  // weight 0 at 40% acc, 1.0 at 50%, 3.0 at 70%+
  return Math.max(0, (acc - 0.40) / 0.10);
}

// Store last predictions per algo to update accuracy
let lastAlgoPreds = {};

function recordAccuracy(actual) {
  for (const [name, pred] of Object.entries(lastAlgoPreds)) {
    updateAlgoAcc(name, pred, actual);
  }
  lastAlgoPreds = {};
}

// ══════════════════════════════════════════════════════════════
//  PATTERN DETECTION  (improved)
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join(""); // seq is newest→oldest

  // Bệt (streak): ≥3 same
  const bMatch = s.match(/^(T{3,}|X{3,})/);
  if (bMatch) {
    const len = bMatch[0].length;
    // after 5+ streak, break is more likely
    const next = len >= 6 ? (bMatch[0][0] === "T" ? "X" : "T") : bMatch[0][0];
    const conf = len >= 6 ? 0.65 : 0.55 + len * 0.03;
    return { name: "Bệt " + bMatch[0][0], next, conf: Math.min(conf, 0.82) };
  }

  // 1-1 (alternating)
  let altLen = 0;
  for (let i = 0; i < Math.min(seq.length, 10); i++) {
    if (i === 0 || seq[i] !== seq[i-1]) altLen++;
    else break;
  }
  if (altLen >= 5) {
    return { name: "Cầu 1-1", next: seq[0] === "T" ? "X" : "T", conf: 0.70 };
  }
  if (altLen >= 4) {
    return { name: "Cầu 1-1", next: seq[0] === "T" ? "X" : "T", conf: 0.62 };
  }

  // 2-2  TTXX TTXX ...
  if (s.length >= 8) {
    const a = s.slice(0,2), b = s.slice(2,4), c = s.slice(4,6), d = s.slice(6,8);
    if (a===c && b===d && a!==b) {
      // in a "2-2" block — predict continuation
      const blockPos = 0; // we're at top of block
      const next = a[0]; // repeat current pair
      return { name: "Cầu 2-2", next, conf: 0.66 };
    }
  }

  // 3-3
  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3]) {
    // currently in first block → continue
    return { name: "Cầu 3-3", next: s[0], conf: 0.64 };
  }

  // 1-2 TXXTTXX
  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5]) {
    return { name: "Cầu 1-2", next: s[0], conf: 0.60 };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
//  ALGORITHMS
// ══════════════════════════════════════════════════════════════

// 2nd-order Markov
function algoMarkov2(seq) {
  if (seq.length < 15) return null;
  const trans = {};
  for (let i = 2; i < seq.length; i++) {
    const key = seq[i-1] + seq[i-2]; // "TT","TX","XT","XX"
    if (!trans[key]) trans[key] = { T:0, X:0 };
    trans[key][seq[i-2] === seq[i-1] ? seq[i] : seq[i]]++;
    // fix: just count properly
  }
  // rebuild properly
  const t2 = { TT:{T:0,X:0}, TX:{T:0,X:0}, XT:{T:0,X:0}, XX:{T:0,X:0} };
  for (let i = 2; i < seq.length; i++) {
    const key = seq[i-1] + seq[i-2];
    if (t2[key]) t2[key][seq[i-2]]++; // BUG: fix below
  }
  // Actually: given prev2=seq[1], prev1=seq[0], predict next
  // seq is newest→oldest, so seq[0]=most recent
  // transition: from state (seq[1],seq[0]) → next
  const t3 = { TT:{T:0,X:0}, TX:{T:0,X:0}, XT:{T:0,X:0}, XX:{T:0,X:0} };
  // seq[i] is older, seq[i-1] newer, seq[i-2] newest of the three
  // for predicting seq[i-2] given seq[i-1],seq[i]:
  for (let i = 2; i < seq.length; i++) {
    const state = seq[i] + seq[i-1]; // older→newer
    if (t3[state]) t3[state][seq[i-2]]++;
  }
  const curState = seq[1] + seq[0];
  const row = t3[curState];
  if (!row) return null;
  const total = row.T + row.X;
  if (total < 6) return null;
  if (row.T > row.X) return { next:"T", conf: 0.5 + (row.T/total - 0.5)*0.7 };
  if (row.X > row.T) return { next:"X", conf: 0.5 + (row.X/total - 0.5)*0.7 };
  return null;
}

// 1st-order Markov
function algoMarkov1(seq) {
  if (seq.length < 10) return null;
  const tr = { T:{T:0,X:0}, X:{T:0,X:0} };
  for (let i = 1; i < seq.length; i++) {
    tr[seq[i]][seq[i-1]]++; // given older seq[i], next is seq[i-1]
  }
  const cur = seq[0];
  // from cur, what's the next?
  // tr[older][newer]  → we want P(next | cur)
  // Actually flip: tr[seq[i]] counts how many times seq[i-1] follows seq[i]
  // So P(seq[i-1]=X | seq[i]=cur) = tr[cur][X] / sum
  const toT = tr[cur].T;
  const toX = tr[cur].X;
  const total = toT + toX;
  if (total < 6) return null;
  if (toT > toX) return { next:"T", conf: 0.5 + (toT/total-0.5)*0.65 };
  if (toX > toT) return { next:"X", conf: 0.5 + (toX/total-0.5)*0.65 };
  return null;
}

// Frequency bias (regression to mean)
function algoFreq(seq) {
  const n = Math.min(seq.length, 40);
  const sub = seq.slice(0, n);
  const cntT = sub.filter(x => x==="T").length;
  const ratioT = cntT / n;
  const ratioX = 1 - ratioT;
  if (ratioT > 0.60) return { next:"X", conf: 0.50 + (ratioT-0.50)*0.55 };
  if (ratioX > 0.60) return { next:"T", conf: 0.50 + (ratioX-0.50)*0.55 };
  return null;
}

// Sóng / luồng
function algoLuong(seq) {
  if (seq.length < 8) return null;
  const w = seq.slice(0, 8);
  let trans = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i-1]) trans++;
  // trans 0-1 = strong streak → continue
  if (trans <= 1) return { next: w[0], conf: 0.63 };
  // trans 7 = pure alternating → flip
  if (trans >= 7) return { next: w[0]==="T"?"X":"T", conf: 0.63 };
  return null;
}

// Dice sum statistical bias
function algoDice(hist) {
  if (hist.length < 20) return null;
  const recent = hist.slice(0, 20);
  const avg = recent.reduce((a,b) => a+b.tong, 0) / recent.length;
  // theoretical mean = 10.5
  if (avg < 9.8)  return { next:"X", conf: 0.57 };
  if (avg > 11.2) return { next:"T", conf: 0.57 };
  return null;
}

// Streak-5 break
function algoStreak5(seq) {
  if (seq.length < 5) return null;
  const last = seq.slice(0, 5);
  if (last.every(x => x===last[0])) {
    // 5 same → high probability break
    return { next: last[0]==="T"?"X":"T", conf: 0.66 };
  }
  return null;
}

// Entropy / chaos detector → avoid predicting in chaotic windows
function algoEntropy(seq) {
  const n = Math.min(seq.length, 16);
  const sub = seq.slice(0, n);
  let trans = 0;
  for (let i = 1; i < sub.length; i++) if (sub[i] !== sub[i-1]) trans++;
  const entropy = trans / (n - 1);
  // entropy ~0.5 = random → abstain
  if (entropy > 0.42 && entropy < 0.58) return null;
  // Low entropy → streak continuing
  if (entropy < 0.35) return { next: sub[0], conf: 0.60 };
  // High entropy → flip
  if (entropy > 0.65) return { next: sub[0]==="T"?"X":"T", conf: 0.58 };
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ENSEMBLE  (adaptive weighted voting)
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 5) return { next:"?", conf:0, cauType:"Chưa đủ dữ liệu", pattern:"" };

  const seq = hist.map(h => h.type); // newest → oldest

  const votes   = { T:0, X:0 };
  const wSum    = { T:0, X:0 };
  const algoLog = {};

  const add = (name, result, baseW) => {
    if (!result) return;
    const adaptW = baseW * getAlgoWeight(name);
    votes[result.next]  += adaptW;
    wSum[result.next]   += result.conf * adaptW;
    algoLog[name]        = result.next;
  };

  const pat = detectPattern(seq);
  add("pattern",  pat,                    4.0);
  add("markov2",  algoMarkov2(seq),       3.0);
  add("markov1",  algoMarkov1(seq),       2.5);
  add("freq",     algoFreq(seq),          1.5);
  add("luong",    algoLuong(seq),         1.5);
  add("dice",     algoDice(hist),         1.0);
  add("streak5",  algoStreak5(seq),       2.0);
  add("entropy",  algoEntropy(seq),       1.0);

  // Store predictions for accuracy tracking
  lastAlgoPreds = algoLog;

  const totT = wSum.T || 0;
  const totX = wSum.X || 0;
  const tot  = totT + totX;

  let next = "T", finalConf = 0.50;
  if (tot > 0) {
    if (totT >= totX) { next = "T"; finalConf = totT / tot; }
    else              { next = "X"; finalConf = totX / tot; }
  }

  // Clamp confidence to realistic range
  finalConf = Math.min(Math.max(finalConf, 0.50), 0.88);

  const patternStr = seq.slice(0, 14).join("");
  const cauType    = pat ? pat.name
    : votes.T > votes.X ? "Nghiêng Tài"
    : votes.X > votes.T ? "Nghiêng Xỉu"
    : "Cân Bằng";

  return {
    next: next === "T" ? "Tài" : "Xỉu",
    conf: Math.round(finalConf * 100),
    cauType,
    pattern: patternStr,
  };
}

// ══════════════════════════════════════════════════════════════
//  SYNC
// ══════════════════════════════════════════════════════════════
let prevTopPhien = null;

async function syncHistory() {
  try {
    const { ok, body } = await fetchSource();
    if (!ok) return;
    const sessions = extractSessions(body);
    if (!sessions.length) return;

    const before = history[0]?.phien;
    ingest(sessions);
    const after  = history[0]?.phien;

    // New phien arrived → update algo accuracy based on actual result
    if (before && after && after !== before && prevTopPhien === before) {
      // history[0] is now the new phien, history[1] is the one we predicted for
      if (history.length >= 2) {
        recordAccuracy(history[1].type); // actual result of previously predicted phien
      }
    }
    prevTopPhien = after;
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── /predict ─────────────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu", hint:"GET /debug" }));
      return;
    }
    const latest = history[0];
    const pred   = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien:          latest.phien,
      xuc_xac:        latest.dice,
      phien_hien_tai: String(Number(latest.phien) + 1),
      du_doan:        pred.next,
      do_tin_cay:     pred.conf + "%",
      loai_cau:       pred.cauType,
      pattern:        pred.pattern,
    }));
    return;
  }

  // ── /history ──────────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data: history.slice(0, limit).map(h => ({
        phien:   h.phien,
        xuc_xac: h.dice,
        tong:    h.tong,
        ket_qua: h.type === "T" ? "Tài" : "Xỉu",
      })),
    }));
    return;
  }

  // ── /debug ────────────────────────────────────────────────────
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e => ({ error: e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
    return;
  }

  // ── /stats ────────────────────────────────────────────────────
  if (url.pathname === "/stats") {
    const stats = {};
    for (const [name, a] of Object.entries(algoAcc)) {
      stats[name] = {
        accuracy: a.total ? Math.round(a.correct/a.total*100) + "%" : "N/A",
        weight:   Math.round(getAlgoWeight(name) * 100) / 100,
        samples:  Math.round(a.total),
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({ algo_stats: stats, history_count: history.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));

}).listen(PORT, () => {
  console.log("✅ API port " + PORT);
  console.log("  /predict  → dự đoán phiên kế");
  console.log("  /history  → lịch sử");
  console.log("  /stats    → độ chính xác từng thuật toán");
  console.log("  /debug    → raw JSON nguồn");
  syncHistory();
  setInterval(syncHistory, 12000);
});
