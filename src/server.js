const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 300;

let history = []; // newest → oldest

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
//  PARSE  — cấu trúc thực tế từ nguồn:
//  body.list[i] = { id, resultTruyenThong:"TAI"|"XIU", dices:[d1,d2,d3], point }
// ══════════════════════════════════════════════════════════════
function parseSession(s) {
  if (!s || typeof s !== "object") return null;

  const phien = String(s.id ?? s._id ?? "?");

  // Dice: field tên "dices"
  let dice = null;
  if (Array.isArray(s.dices) && s.dices.length >= 3) {
    dice = s.dices.slice(0, 3).map(Number);
  } else if (Array.isArray(s.dice) && s.dice.length >= 3) {
    dice = s.dice.slice(0, 3).map(Number);
  }
  if (!dice || !dice.every(x => x >= 1 && x <= 6)) return null;

  // Tổng: dùng field point nếu có, không thì tính
  const tong = typeof s.point === "number" ? s.point : dice.reduce((a,b) => a+b, 0);

  // Kết quả: resultTruyenThong = "TAI" | "XIU"
  let type = null;
  const r = (s.resultTruyenThong || s.result || "").toUpperCase();
  if (r.includes("TAI") || r.includes("TÀI") || r === "T" || r === "BIG")  type = "T";
  else if (r.includes("XIU") || r.includes("XỈU") || r === "X" || r === "SMALL") type = "X";
  else type = tong >= 11 ? "T" : "X"; // fallback

  return { phien, dice, tong, type };
}

function ingest(list) {
  const existing = new Set(history.map(h => h.phien));
  const parsed   = list.map(parseSession).filter(Boolean);
  // list từ API: index 0 = mới nhất
  for (const item of parsed) {
    if (!existing.has(item.phien)) {
      history.push(item);
      existing.add(item.phien);
    }
  }
  // Sort by id desc (newest first)
  history.sort((a,b) => Number(b.phien) - Number(a.phien));
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
}

// ══════════════════════════════════════════════════════════════
//  SELF-CALIBRATING WEIGHT  (adaptive)
// ══════════════════════════════════════════════════════════════
const ALGOS = ["pattern","markov2","markov1","freq","luong","dice","streak5","entropy"];
const acc = {};
for (const n of ALGOS) acc[n] = { c: 20, t: 40 }; // khởi đầu 50%

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred === actual) acc[name].c++;
  if (acc[name].t > 60) {
    acc[name].c *= 60 / acc[name].t;
    acc[name].t  = 60;
  }
}

function weight(name) {
  const a = acc[name];
  if (!a || a.t < 8) return 1.0;
  const r = a.c / a.t;
  // 40%→0, 50%→1, 70%→3
  return Math.max(0, (r - 0.40) / 0.10);
}

let lastPreds = {};

function recordActual(actual) {
  for (const [name, pred] of Object.entries(lastPreds)) updateAcc(name, pred, actual);
  lastPreds = {};
}

// ══════════════════════════════════════════════════════════════
//  PATTERN DETECTION
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join(""); // newest→oldest

  // Bệt ≥3
  const bm = s.match(/^(T{3,}|X{3,})/);
  if (bm) {
    const len  = bm[0].length;
    const same = bm[0][0];
    // bệt dài ≥6 → kỳ vọng gãy
    const next = len >= 6 ? (same==="T"?"X":"T") : same;
    const conf = len >= 6 ? 0.67 : Math.min(0.55 + len*0.03, 0.78);
    return { name: `Bệt ${same}`, next, conf };
  }

  // Cầu 1-1 (xen kẽ)
  let alt = 0;
  for (let i = 0; i < Math.min(seq.length,10); i++) {
    if (i===0 || seq[i]!==seq[i-1]) alt++;
    else break;
  }
  if (alt >= 5) return { name:"Cầu 1-1", next: seq[0]==="T"?"X":"T", conf: 0.71 };
  if (alt >= 4) return { name:"Cầu 1-1", next: seq[0]==="T"?"X":"T", conf: 0.63 };

  // Cầu 2-2: TTXXTTXX
  if (s.length >= 8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4]) {
    // ta đang ở đầu block mới → tiếp tục
    return { name:"Cầu 2-2", next: s[0], conf: 0.67 };
  }

  // Cầu 3-3
  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3]) {
    return { name:"Cầu 3-3", next: s[0], conf: 0.64 };
  }

  // Cầu 1-2: TXXTTXX
  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5]) {
    return { name:"Cầu 1-2", next: s[0], conf: 0.60 };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
//  ALGORITHMS
// ══════════════════════════════════════════════════════════════

// Markov bậc 2: P(next | prev1, prev0)
// seq: newest→oldest → seq[0]=most recent, seq[1]=prev, seq[2]=prev prev
// predict seq[-1] (future) given seq[0],seq[1]
function algoMarkov2(seq) {
  if (seq.length < 15) return null;
  // Build: given state (seq[i+1], seq[i]), what was seq[i-1]?
  // i.e. given (older, newer) → even newer
  const t = {};
  for (let i = 0; i < seq.length - 2; i++) {
    // seq[i]=newest of triple, seq[i+1]=middle, seq[i+2]=oldest
    const state = seq[i+2] + seq[i+1]; // older→newer
    if (!t[state]) t[state] = {T:0,X:0};
    t[state][seq[i]]++;
  }
  const state = seq[1] + seq[0]; // (older, newer) → predict future
  const row = t[state];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < 6) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.70 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.70 };
  return null;
}

// Markov bậc 1
function algoMarkov1(seq) {
  if (seq.length < 10) return null;
  // t[cur][next] = count
  const t = { T:{T:0,X:0}, X:{T:0,X:0} };
  for (let i = 0; i < seq.length - 1; i++) {
    t[seq[i+1]][seq[i]]++; // given older seq[i+1], next is seq[i]
  }
  // given seq[0] (most recent), predict next
  const row = t[seq[0]];
  const tot = row.T + row.X;
  if (tot < 6) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.65 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.65 };
  return null;
}

// Tần suất hồi quy
function algoFreq(seq) {
  const n   = Math.min(seq.length, 40);
  const sub = seq.slice(0, n);
  const rT  = sub.filter(x=>x==="T").length / n;
  const rX  = 1 - rT;
  if (rT > 0.62) return { next:"X", conf: 0.50 + (rT-0.50)*0.55 };
  if (rX > 0.62) return { next:"T", conf: 0.50 + (rX-0.50)*0.55 };
  return null;
}

// Sóng / luồng 8 phiên
function algoLuong(seq) {
  if (seq.length < 8) return null;
  const w = seq.slice(0, 8);
  let tr = 0;
  for (let i = 1; i < w.length; i++) if (w[i]!==w[i-1]) tr++;
  if (tr <= 1) return { next: w[0], conf: 0.63 };         // streak mạnh
  if (tr >= 7) return { next: w[0]==="T"?"X":"T", conf: 0.63 }; // xen kẽ mạnh
  return null;
}

// Dice sum bias
function algoDice(hist) {
  if (hist.length < 20) return null;
  const avg = hist.slice(0,20).reduce((a,b)=>a+b.tong,0) / 20;
  if (avg < 9.8)  return { next:"X", conf: 0.57 };
  if (avg > 11.2) return { next:"T", conf: 0.57 };
  return null;
}

// Streak-5 → kỳ vọng gãy
function algoStreak5(seq) {
  if (seq.length < 5) return null;
  const f = seq[0];
  if (seq.slice(0,5).every(x=>x===f)) return { next: f==="T"?"X":"T", conf: 0.66 };
  return null;
}

// Entropy
function algoEntropy(seq) {
  const n   = Math.min(seq.length, 16);
  const sub = seq.slice(0, n);
  let tr = 0;
  for (let i = 1; i < sub.length; i++) if (sub[i]!==sub[i-1]) tr++;
  const e = tr / (n-1);
  if (e > 0.40 && e < 0.60) return null; // quá ngẫu nhiên → bỏ qua
  if (e <= 0.40) return { next: sub[0], conf: 0.60 };          // xu hướng rõ
  if (e >= 0.60) return { next: sub[0]==="T"?"X":"T", conf: 0.58 };
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ENSEMBLE
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 5) return { next:"?", conf:0, cauType:"Chưa đủ dữ liệu", pattern:"" };

  const seq  = hist.map(h => h.type); // newest→oldest
  const wSum = { T:0, X:0 };

  const add = (name, res, base) => {
    if (!res) return;
    lastPreds[name] = res.next;
    const w = base * weight(name);
    wSum[res.next] += res.conf * w;
  };

  const pat = detectPattern(seq);
  add("pattern", pat,               4.0);
  add("markov2", algoMarkov2(seq),  3.0);
  add("markov1", algoMarkov1(seq),  2.5);
  add("freq",    algoFreq(seq),     1.5);
  add("luong",   algoLuong(seq),    1.5);
  add("dice",    algoDice(hist),    1.0);
  add("streak5", algoStreak5(seq),  2.0);
  add("entropy", algoEntropy(seq),  1.0);

  const tot = wSum.T + wSum.X;
  let next = "T", conf = 0.50;
  if (tot > 0) {
    if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
    else                  { next = "T"; conf = wSum.T / tot; }
  }

  conf = Math.min(Math.max(conf, 0.50), 0.88);

  const patStr  = seq.slice(0,14).join("");
  const cauType = pat ? pat.name
    : wSum.T > wSum.X ? "Nghiêng Tài"
    : wSum.X > wSum.T ? "Nghiêng Xỉu"
    : "Cân Bằng";

  return { next: next==="T"?"Tài":"Xỉu", conf: Math.round(conf*100), cauType, pattern: patStr };
}

// ══════════════════════════════════════════════════════════════
//  SYNC
// ══════════════════════════════════════════════════════════════
let prevTop = null;

async function syncHistory() {
  try {
    const { ok, body } = await fetchSource();
    if (!ok || !body) return;

    const list = body.list ?? body.data?.list ?? body.data ?? body.sessions ?? [];
    if (!Array.isArray(list) || !list.length) return;

    const before = history[0]?.phien;
    ingest(list);
    const after = history[0]?.phien;

    // Phiên mới về → cập nhật accuracy
    if (before && after !== before && prevTop === before && history.length >= 2) {
      recordActual(history[1].type);
    }
    prevTop = after;
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // /predict
  if (url.pathname==="/predict" || url.pathname==="/") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const h    = history[0];
    const pred = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien:          h.phien,
      xuc_xac:        h.dice,
      phien_hien_tai: String(Number(h.phien) + 1),
      du_doan:        pred.next,
      do_tin_cay:     pred.conf + "%",
      loai_cau:       pred.cauType,
      pattern:        pred.pattern,
    }));
    return;
  }

  // /history
  if (url.pathname==="/history") {
    await syncHistory();
    const lim = Math.min(parseInt(url.searchParams.get("limit")||"20"),100);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data:  history.slice(0,lim).map(h=>({
        phien:   h.phien,
        xuc_xac: h.dice,
        tong:    h.tong,
        ket_qua: h.type==="T"?"Tài":"Xỉu",
      }))
    }));
    return;
  }

  // /stats — accuracy từng algo
  if (url.pathname==="/stats") {
    const out = {};
    for (const n of ALGOS) {
      const a = acc[n];
      out[n] = {
        accuracy: a.t ? Math.round(a.c/a.t*100)+"%" : "N/A",
        weight:   Math.round(weight(n)*100)/100,
        samples:  Math.round(a.t),
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({ algo_stats: out, history_count: history.length }));
    return;
  }

  // /debug
  if (url.pathname==="/debug") {
    const r = await fetchSource().catch(e=>({ error:e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error:"Not found" }));

}).listen(PORT, () => {
  console.log("✅ port " + PORT);
  syncHistory();
  setInterval(syncHistory, 12000);
});
