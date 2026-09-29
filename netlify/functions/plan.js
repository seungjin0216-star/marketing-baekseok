/**
 * 콘텐츠 계획 조회 / 생성 / 상태 변경
 *
 *   GET  /plan                    이번 달 계획 + 이번 주 미션
 *   POST /plan  {action:"suggest", 연월:"2026-08", 방향:"..."}   AI가 계획 초안 제안 (저장 안 함)
 *   POST /plan  {action:"save", 연월:"2026-08", items:[...]}     계획 확정 저장
 *   POST /plan  {action:"done", id:"..."}                        미션 완료 처리
 */
const { readTab, appendRows, updateCell, clearTab, json } = require("./_google");
const { getRankBrief } = require("./_rank");
const { getPlaceInfo, 프롬프트문장: 매장문장, 소식공백일수 } = require("./_place");
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

/** 이달 며칠인지로 몇째 주인지 (1~4)
 *
 *  🔴 2026-09-29 — 5주차를 없앴습니다.
 *
 *  ⚠️ 그전에는 1~5주였는데 계획은 1~4주만 만들었습니다.
 *     그래서 **매달 29~31일 사흘은 미션이 통째로 비었고**,
 *     화면에는 「이번 주 미션 완료 ✨」로 떴습니다.
 *     사장님이 하필 9/29 에 여셔서 이걸 보셨습니다.
 *
 *  ⚠️ 오류가 안 납니다. 그냥 「할 게 없다」고 나옵니다 — 또 조용한 실패입니다.
 *     이제 29~31일은 4주차로 칩니다.
 */
function weekOfMonth(d = new Date()) {
  const k = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return Math.min(4, Math.ceil(k.getDate() / 7));
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

// ⚠️ 2026-09-29 — 8건 → 6건 (한 주에 1~2건)
//    사장님: 「이번주 3,4개는 너무 많아. 주에 1,2개로 하자」
//    ⚠️ 많이 주면 아예 손을 안 댑니다. 적게 주고 실제로 하는 게 낫습니다.
async function suggest({ 연월, 방향 = "", 개수 = 6 }) {
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

  // 우리 가게가 실제로 뭘 파는지 — 없으면 뻔한 주제만 나온다
  let 매장 = "";
  try {
    const info = await getPlaceInfo();
    const t = 매장문장(info, { 소개글길이: 500 });
    if (t) 매장 = "\n\n" + t;
    const 공백 = 소식공백일수(info);
    if (공백 !== null && 공백 > 45) {
      매장 += `\n\n※ 마지막 소식글이 ${공백}일 전입니다. 소식글이 오래 비면 플레이스 노출에 불리하므로,`
            + ` 이번 달 계획에 네이버 소식글을 우선으로 넣으세요.`;
    }
  } catch (e) { /* 매장 정보를 못 읽어도 계획은 세운다 */ }

  const prompt = `당신은 '${CFG.FULL_NAME}'의 마케팅 담당자입니다.
${연월} 한 달치 콘텐츠 계획을 ${개수}건 세워주세요.

[가게 정보]
지역 키워드: ${CFG.AREA_KEYWORDS.join(", ")}
메뉴: ${CFG.MENU_KEYWORDS.join(", ")}
강점: ${CFG.SELLING_POINTS.join(" / ")}${매장}${순위}

[이번 달 방향]
${방향 || "특별한 요청 없음 — 계절과 요일 특성을 고려해 알아서 구성"}

[최근에 다룬 주제 — 겹치지 않게]
${지난주제.length ? 지난주제.join(", ") : "없음"}

[업계에서 요즘 나오는 이야기 — 최근 2개월 수집]
${인사이트.length ? 인사이트.join("\n") : "수집된 내용 없음"}
※ 위 흐름을 참고해 지금 통할 만한 주제로 구성하세요.
   예를 들어 블로그 효과가 떨어졌다는 얘기가 많으면 플레이스 소식글·영수증리뷰 쪽에 무게를 두는 식으로.

[지켜야 할 것]
- 주차는 1~4주만 씁니다. 5주차는 없습니다
- ⚠️ 한 주에 1~2건만 넣으세요. 절대 3건 이상 넣지 마세요
  (사장님이 혼자 하십니다. 많으면 아예 손을 안 댑니다)
- 같은 주제를 두 번 쓰지 마세요. 제목이 비슷해도 안 됩니다
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

// ⚠️ 2026-09-29 — 그 달 계획을 **갈아끼웁니다**
//
//    그전에는 append 만 해서 「AI에게 계획 제안받기」를 누를 때마다 쌓였습니다.
//    사장님 시트에 같은 글이 24건까지 불었습니다.
//
//    ⚠️ 이미 완료한 것은 남깁니다. 한 일까지 지우면 기록이 사라집니다.
//    ⚠️ 다른 달 계획은 건드리지 않습니다.
async function save({ 연월, items }) {
  if (!Array.isArray(items) || !items.length) throw new Error("저장할 계획이 없습니다.");
  const rows = await readTab(T.name, T.headers);
  const today = new Date().toISOString().slice(0, 10);

  // 남길 것: 다른 달 전부 + 이 달에서 이미 완료한 것
  const 남길것 = rows.filter((r) =>
    String(r["연월"]) !== String(연월) || String(r["상태"]) === "완료"
  );
  const 지운수 = rows.length - 남길것.length;

  if (지운수 > 0) {
    await clearTab(T.name, T.headers);
    if (남길것.length) await appendRows(T.name, T.headers, 남길것);
  }

  let next = 남길것.length + 1;
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
  return { saved: items.length, 지운수 };
}

async function markDone({ id }) {
  const rows = await readTab(T.name, T.headers);
  const idx = rows.findIndex((r) => r["id"] === id);
  if (idx < 0) throw new Error("해당 계획을 찾지 못했습니다.");
  await updateCell(T.name, T.headers, idx, "상태", "완료");
  await updateCell(T.name, T.headers, idx, "완료일", new Date().toISOString().slice(0, 10));
  return { ok: true };
}
