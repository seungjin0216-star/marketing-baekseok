/**
 * 카톡 대화 → 인사이트 추출·저장
 *
 *   GET  /insight                      저장된 인사이트 (최근순)
 *   GET  /insight?days=30              최근 N일치만
 *   POST /insight  { text: "대화 원문", 출처: "오픈채팅방 이름" }
 *
 * 왜 2단계인가
 *   오픈채팅은 하루 150건씩 쌓이고 대부분이 잡담이다.
 *   전부 AI에 넣으면 비싸고 요약도 뭉개진다.
 *   그래서 ① 규칙으로 후보를 30분의 1로 줄이고 ② AI가 진짜만 골라낸다.
 *
 * 발화자 닉네임은 저장하지 않는다. 필요한 건 내용이지 누가 말했는지가 아니다.
 */
const { readTab, appendRows, json } = require("./_google");
const CFG = require("./_config");

const T = CFG.TABS.인사이트;

// 후보를 거르는 키워드 (업계 얘기인지 판단)
const KEYWORDS = [
  "플레이스", "상위노출", "저장수", "키워드", "검색량", "노출", "순위",
  "영수증리뷰", "블로그", "체험단", "리뷰", "별점",
  "저품질", "제재", "패널티", "정책", "단속", "로직", "알고리즘",
  "cpc", "광고비", "파워링크", "입찰", "전환", "유입", "체류",
  "인스타", "릴스", "숏폼", "소식", "당근", "배민",
  "대행사", "업체", "단가", "수수료", "매출",
];

// 사담·잡담 신호
const DROP = ["ㅋㅋ", "ㅎㅎ", "감사합니다", "안녕하세요", "고소", "남친", "여친", "술먹", "형님"];

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const days = Number(event.queryStringParameters?.days || 0);
      let rows = await readTab(T.name, T.headers);
      if (days) {
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        rows = rows.filter((r) => (r["수집일"] || "") >= since);
      }
      return json(200, { rows: rows.slice(-200).reverse(), total: rows.length });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "지원하지 않는 요청입니다." });

    const { text = "", 출처 = "오픈채팅" } = JSON.parse(event.body || "{}");
    if (text.trim().length < 100) throw new Error("대화 내용이 너무 짧습니다.");

    const candidates = pickCandidates(text);
    if (!candidates.length) {
      return json(200, { ok: true, 후보: 0, 저장: 0, message: "업계 관련 내용을 찾지 못했습니다." });
    }

    const existing = await readTab(T.name, T.headers);
    const seen = new Set(existing.map((r) => normalize(r["원문"] || "")));

    const fresh = candidates.filter((c) => !seen.has(normalize(c.text)));
    if (!fresh.length) {
      return json(200, { ok: true, 후보: candidates.length, 저장: 0, message: "모두 이미 저장된 내용입니다." });
    }

    const insights = await extract(fresh);
    if (!insights.length) {
      return json(200, { ok: true, 후보: fresh.length, 저장: 0, message: "쓸 만한 인사이트가 없었습니다." });
    }

    const today = new Date().toISOString().slice(0, 10);
    let nextId = existing.length + 1;
    await appendRows(T.name, T.headers, insights.map((it) => ({
      id: nextId++,
      수집일: today,
      발화일: it.발화일 || "",
      분류: it.분류 || "기타",
      요약: it.요약 || "",
      원문: (it.원문 || "").slice(0, 300),
      실행가능: it.실행가능 ? "Y" : "",
      출처,
    })));

    return json(200, { ok: true, 후보: fresh.length, 저장: insights.length, insights });
  } catch (e) {
    return json(500, { error: e.message });
  }
};

const normalize = (s) => String(s).replace(/\s+/g, "").slice(0, 40);

/** 카톡 내보내기 원문에서 업계 얘기로 보이는 줄만 추린다 */
function pickCandidates(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  // 2026. 4. 12. 17:50, 닉네임 : 내용
  const re = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*\d{1,2}:\d{2},\s*.+?\s*:\s*(.*)$/;

  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const date = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    const t = m[4].replace(/\s+/g, " ").trim();

    if (t.length < 30 || t.length > 300) continue;
    if (t.includes("http")) continue;
    const low = t.toLowerCase();
    if (!KEYWORDS.some((k) => low.includes(k))) continue;
    if (DROP.some((d) => t.includes(d))) continue;

    const key = normalize(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, text: t });
  }
  // 너무 많으면 최근 것 위주로 (한 번에 처리할 양 제한)
  return out.slice(-400);
}

/** AI가 후보 중 진짜 인사이트만 골라 요약한다 */
async function extract(candidates) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 환경변수가 없습니다.");

  const body = candidates.map((c, i) => `${i + 1}. [${c.date}] ${c.text}`).join("\n");

  const prompt = `아래는 자영업자 오픈채팅방에서 뽑아낸 발언들입니다.
'${CFG.FULL_NAME}' 사장님에게 **실제로 도움이 될 내용만** 골라 정리하세요.

[골라야 할 것]
- 네이버 플레이스 순위·노출에 대한 구체적인 경험이나 관찰
- 광고 운영 노하우, 실제 비용·성과 수치
- 정책 변화, 제재 사례, 알고리즘 변화 신호
- 리뷰·체험단 운영에서 통했거나 실패한 방법
- 지금 쓸 수 있는 혜택·지원 정보

[버려야 할 것]
- 단순 질문 (답이 없는 것)
- 개인 사정, 잡담, 인사
- 근거 없는 추측이나 감상
- 홍보·영업 글

[지켜야 할 것]
- 여러 사람이 비슷한 말을 하면 **하나로 합쳐서** 정리하세요
- 요약은 사장님이 바로 이해할 수 있게 한 문장으로
- 원문은 근거로 쓸 수 있게 가장 대표적인 발언을 그대로 옮기세요
- 없는 내용을 지어내면 안 됩니다
- 30건을 넘기지 마세요. 중요한 것만 남기세요

분류는 다음 중에서 고르세요: ${CFG.INSIGHT_CATEGORIES.join(" / ")}
"실행가능"은 사장님이 이번 주에 바로 해볼 수 있는 것이면 true 입니다.

[발언 목록]
${body}

아래 JSON 형식으로만 답하세요.
{"insights":[{"발화일":"2026-07-04","분류":"광고·비용","요약":"...","원문":"...","실행가능":true}]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message || "인사이트 추출 실패");
  return JSON.parse(text).insights || [];
}
