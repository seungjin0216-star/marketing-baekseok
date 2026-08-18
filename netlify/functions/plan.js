/**
 * 콘텐츠 계획 조회 / 생성 / 상태 변경
 *
 *   GET  /plan                    이번 달 계획 + 이번 주 미션
 *   POST /plan  {action:"suggest", 연월:"2026-08", 방향:"..."}   AI가 계획 초안 제안 (저장 안 함)
 *   POST /plan  {action:"save", 연월:"2026-08", items:[...]}     계획 확정 저장
 *   POST /plan  {action:"done", id:"..."}                        미션 완료 처리
 */
const { readTab, appendRows, updateCell, json } = require("./_google");
const { getRankBrief } = require("./_rank");
const CFG = require("./_config");

const T = CFG.TABS.계획;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") return json(200, await getPlan());

    const body = JSON.parse(event.body || "{}");
    if (body.action === "suggest") return json(200, await suggest(body));
    if (body.action === "save")    return json(200, await save(body));
    if (body.action === "done")    return json(200, await markDone(body));
    return json(400, { error: "알 수 없는 요청입니다." });
  } catch (e) {
    return json(500, { error: e.message });
  }
};

function ym(d = new Date()) {
  const k = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}`;
}

/** 이달 며칠인지로 몇째 주인지 (1~5) */
function weekOfMonth(d = new Date()) {
  const k = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return Math.min(5, Math.ceil(k.getDate() / 7));
}

async function getPlan() {
  const rows = await readTab(T.name, T.headers);
  const 연월 = ym();
  const 주차 = weekOfMonth();
  const month = rows.filter((r) => r["연월"] === 연월);

  // 홈에 "지금 밀리는 키워드"를 같이 보여준다. 실패해도 계획은 나와야 한다.
  let 순위 = null;
  try {
    const b = await getRankBrief();
    if (b) {
      순위 = {
        측정일: b.측정일 || "",
        밀림: (b.밀림 || []).slice(0, 5),
        놓침: (b.놓침 || []).slice(0, 5),
        지킴: (b.지킴 || []).slice(0, 5),
        사유: b.사유 || "",
      };
    }
  } catch (e) { /* 순위는 곁다리다 */ }

  return {
    연월,
    주차,
    이번주미션: month.filter((r) => String(r["주차"]) === String(주차) && r["상태"] !== "완료"),
    이번달계획: month,
    지난달있음: rows.some((r) => r["연월"] < 연월),
    지점: CFG.BRANCH,
    순위,
  };
}

async function suggest({ 연월, 방향 = "", 개수 = 8 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 환경변수가 없습니다.");

  const rows = await readTab(T.name, T.headers);
  const 지난주제 = rows.slice(-20).map((r) => r["주제"]).filter(Boolean);

  // 최근 두 달간 모아둔 업계 인사이트를 계획에 반영한다.
  // 카톡방에서 읽은 흐름이 실제 콘텐츠로 이어지게 하는 부분.
  let 인사이트 = [];
  try {
    const IT = CFG.TABS.인사이트;
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    인사이트 = (await readTab(IT.name, IT.headers))
      .filter((r) => (r["수집일"] || "") >= since)
      .slice(-40)
      .map((r) => `- [${r["분류"]}] ${r["요약"]}`);
  } catch (e) { /* 인사이트가 없어도 계획은 세운다 */ }

  // 순위 트래커가 재고 있는 실제 순위 — 어느 키워드를 노릴지 정하는 근거
  let 순위 = "";
  try {
    const brief = await getRankBrief();
    if (brief && brief.prompt) 순위 = "\n\n" + brief.prompt;
  } catch (e) { /* 순위를 못 읽어도 계획은 세운다 */ }

  const prompt = `당신은 '${CFG.FULL_NAME}'의 마케팅 담당자입니다.
${연월} 한 달치 콘텐츠 계획을 ${개수}건 세워주세요.

[가게 정보]
지역 키워드: ${CFG.AREA_KEYWORDS.join(", ")}
메뉴: ${CFG.MENU_KEYWORDS.join(", ")}
강점: ${CFG.SELLING_POINTS.join(" / ")}${순위}

[이번 달 방향]
${방향 || "특별한 요청 없음 — 계절과 요일 특성을 고려해 알아서 구성"}

[최근에 다룬 주제 — 겹치지 않게]
${지난주제.length ? 지난주제.join(", ") : "없음"}

[업계에서 요즘 나오는 이야기 — 최근 2개월 수집]
${인사이트.length ? 인사이트.join("\n") : "수집된 내용 없음"}
※ 위 흐름을 참고해 지금 통할 만한 주제로 구성하세요.
   예를 들어 블로그 효과가 떨어졌다는 얘기가 많으면 플레이스 소식글·영수증리뷰 쪽에 무게를 두는 식으로.

[지켜야 할 것]
- 주차를 1~4주로 고르게 나눌 것
- 각 건마다 "어떤 사진을 찍어야 하는지" 구체적으로 지시할 것
  (예: "불판 위에서 대창이 익어가는 순간을 위에서 클로즈업")
- 사장님이 실제로 찍을 수 있는 사진이어야 함. 연출이 과한 것 금지
- 채널은 네이버소식 / 인스타 / 당근 중 적합한 것을 고를 것 (여러 개 가능)
- 지역 키워드가 자연스럽게 들어갈 주제로

아래 JSON 형식으로만 답하세요.
{"items":[{"주차":1,"주제":"...","필요한사진":"...","채널":"네이버소식,인스타"}]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message || "계획 생성 실패");
  const parsed = JSON.parse(text);
  return { items: parsed.items || [] };
}

async function save({ 연월, items }) {
  if (!Array.isArray(items) || !items.length) throw new Error("저장할 계획이 없습니다.");
  const rows = await readTab(T.name, T.headers);
  let next = rows.length + 1;
  const today = new Date().toISOString().slice(0, 10);

  await appendRows(T.name, T.headers, items.map((it) => ({
    id: `${연월}-${next++}`,
    연월,
    주차: it.주차 || 1,
    주제: it.주제 || "",
    필요한사진: it.필요한사진 || "",
    채널: it.채널 || "네이버소식",
    상태: "대기",
    생성일: today,
    완료일: "",
  })));
  return { saved: items.length };
}

async function markDone({ id }) {
  const rows = await readTab(T.name, T.headers);
  const idx = rows.findIndex((r) => r["id"] === id);
  if (idx < 0) throw new Error("해당 계획을 찾지 못했습니다.");
  await updateCell(T.name, T.headers, idx, "상태", "완료");
  await updateCell(T.name, T.headers, idx, "완료일", new Date().toISOString().slice(0, 10));
  return { ok: true };
}
