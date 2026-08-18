/**
 * 순위 트래커 → 마케팅앱 연결
 *
 * 무엇을 하나
 *   트래커가 매일 재는 순위를 읽어, 키워드를 세 무리로 나눈다.
 *     놓침   순위 10위 밖 · 200위밖  → 콘텐츠로 노려야 할 것
 *     밀림   최근 일주일 사이 떨어짐 → 급한 것
 *     지킴   5위 안                  → 건드릴 필요 없음
 *   그리고 그걸 AI 프롬프트에 넣을 문장으로 만들어 돌려준다.
 *
 * 왜 필요한가
 *   여태 콘텐츠 계획은 순위를 전혀 모르고 세워졌다.
 *   이미 1위인 키워드로 글을 또 쓰면 아무 소용이 없고,
 *   30위인 키워드는 아무도 안 건드리고 있었다.
 *
 * ⚠️ 이 파일은 절대 예외를 위로 던지지 않는다.
 *    트래커 시트가 안 열려도 콘텐츠 계획은 세워져야 한다. 순위는 '있으면 좋은 것'이다.
 */
const { readTabFrom } = require("./_google");
const CFG = require("./_config");

const 순위밖 = 999;

/** "12" → 12,  "200위밖" · "" · "-" → 999 */
function toRank(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "-" || s.includes("밖")) return 순위밖;
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 순위밖;
}

function 표기(r) {
  return r >= 순위밖 ? "순위밖" : `${r}위`;
}

function 며칠전(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * 키워드별 { 최근순위, 이전순위, 변화 } 를 만든다.
 * 같은 날 여러 검색유형(플레이스·통합)이 있으면 가장 좋은 순위를 쓴다.
 */
function 정리(랭크행들, 비교일수) {
  const byKw = {};                       // 키워드명 → { 날짜 → 최선순위 }
  for (const r of 랭크행들) {
    const kw = String(r["키워드명"] || "").trim();
    const d = String(r["날짜"] || "").trim();
    if (!kw || !d) continue;
    const rank = toRank(r["순위"]);
    byKw[kw] = byKw[kw] || {};
    if (byKw[kw][d] == null || rank < byKw[kw][d]) byKw[kw][d] = rank;
  }

  const 기준일 = 며칠전(비교일수);
  const out = {};
  for (const kw of Object.keys(byKw)) {
    const 날짜들 = Object.keys(byKw[kw]).sort();
    if (!날짜들.length) continue;
    const 최근일 = 날짜들[날짜들.length - 1];
    // 기준일보다 앞선 날짜 중 가장 최근 것 — 없으면 비교하지 않는다
    const 이전일 = 날짜들.filter((d) => d <= 기준일).pop();
    const 최근 = byKw[kw][최근일];
    const 이전 = 이전일 ? byKw[kw][이전일] : null;
    out[kw] = {
      키워드: kw,
      최근순위: 최근,
      이전순위: 이전,
      // 양수 = 좋아짐(숫자가 작아짐), 음수 = 밀림
      변화: 이전 == null ? null : 이전 - 최근,
      측정일: 최근일,
    };
  }
  return out;
}

/**
 * 순위 브리핑을 만든다.
 * @returns {null|{놓침:[],밀림:[],지킴:[],측정일:string,prompt:string,사유?:string}}
 *          연결이 안 됐거나 데이터가 없으면 null
 */
async function getRankBrief() {
  const R = CFG.RANK || {};
  if (!R.sheetId) return null;                    // 연결 안 함 — 조용히 끈다

  let 랭크행, 키워드행;
  try {
    [랭크행, 키워드행] = await Promise.all([
      readTabFrom(R.sheetId, R.탭.랭크),
      readTabFrom(R.sheetId, R.탭.키워드),
    ]);
  } catch (e) {
    // 공유가 안 됐거나 트래커 시트가 바뀐 경우. 계획은 계속 세운다.
    return { 놓침: [], 밀림: [], 지킴: [], prompt: "", 사유: `순위를 못 읽었습니다 — ${e.message}` };
  }

  if (!랭크행 || !랭크행.length) {
    return { 놓침: [], 밀림: [], 지킴: [], prompt: "", 사유: "순위 기록이 비어 있습니다." };
  }

  // 검색량 — 큰 키워드를 먼저 노리기 위해
  const 검색량 = {};
  const 활성 = new Set();
  for (const k of 키워드행 || []) {
    const nm = String(k["키워드명"] || "").trim();
    if (!nm) continue;
    검색량[nm] = parseInt(String(k["월간검색량"] || "0").replace(/[^0-9]/g, ""), 10) || 0;
    if (String(k["활성화"] || "").trim().toUpperCase() === "Y") 활성.add(nm);
  }

  const 표 = 정리(랭크행, R.비교일수 || 7);
  // 추적을 끈 키워드는 최신 데이터가 아니므로 뺀다 (활성 목록이 없으면 전부 본다)
  const 목록 = Object.values(표).filter((x) => !활성.size || 활성.has(x.키워드));

  const 정렬 = (a, b) => (검색량[b.키워드] || 0) - (검색량[a.키워드] || 0);

  const 놓침 = 목록.filter((x) => x.최근순위 > (R.약함 || 10)).sort(정렬);
  const 지킴 = 목록.filter((x) => x.최근순위 <= (R.지킴 || 5)).sort((a, b) => a.최근순위 - b.최근순위);
  const 밀림 = 목록
    .filter((x) => x.변화 != null && x.변화 <= -(R.밀림폭 || 3))
    .sort((a, b) => a.변화 - b.변화);

  const 측정일 = 목록.reduce((m, x) => (x.측정일 > m ? x.측정일 : m), "");

  return { 놓침, 밀림, 지킴, 측정일, prompt: 프롬프트문장(놓침, 밀림, 지킴, 측정일, 검색량) };
}

function 줄(x, 검색량) {
  const v = 검색량[x.키워드] ? `검색량 ${검색량[x.키워드].toLocaleString()}` : "검색량 모름";
  const 변 =
    x.변화 == null ? "" :
    x.변화 > 0 ? `, 일주일 새 ${x.변화}계단 올라옴` :
    x.변화 < 0 ? `, 일주일 새 ${-x.변화}계단 밀림` : "";
  return `- ${x.키워드} — 현재 ${표기(x.최근순위)} (${v}${변})`;
}

function 프롬프트문장(놓침, 밀림, 지킴, 측정일, 검색량) {
  if (!놓침.length && !밀림.length && !지킴.length) return "";

  const p = [`[지금 우리 순위 — ${측정일 || "최근"} 기준]`];

  if (밀림.length) {
    p.push("", "⚠️ 최근 일주일 새 밀린 키워드 — 가장 급합니다");
    p.push(...밀림.slice(0, 5).map((x) => 줄(x, 검색량)));
  }
  if (놓침.length) {
    p.push("", "🎯 아직 못 잡은 키워드 (10위 밖) — 검색량 큰 순서");
    p.push(...놓침.slice(0, 8).map((x) => 줄(x, 검색량)));
  }
  if (지킴.length) {
    p.push("", "✅ 이미 5위 안 — 여기에 더 쓸 필요는 적습니다");
    p.push(...지킴.slice(0, 6).map((x) => `- ${x.키워드} (${표기(x.최근순위)})`));
  }

  p.push(
    "",
    "※ 콘텐츠 주제를 정할 때 위 순위를 반영하세요.",
    "   밀린 키워드 → 이번 달에 가장 먼저 다룰 것",
    "   못 잡은 키워드 → 검색량 큰 것부터 주제에 자연스럽게 녹일 것",
    "   이미 5위 안 → 굳이 또 쓰지 말 것",
    "※ 키워드를 문장에 억지로 끼워넣지 마세요. 손님이 읽을 글이 먼저입니다."
  );
  return p.join("\n");
}

module.exports = { getRankBrief, toRank, 표기 };
