/**
 * 🧹 계획 정리 — 쌓인 계획을 화면에서 치웁니다   2026-09-30
 *
 *  사장님 말: 「시트의 내용들을 한번 다 정리해줘. 또 잘못 만졌다가
 *              행이 꼬일까봐 무서워서. 너무 많은 계획들이 쌓여 있어서 파악이 어려움」
 *
 *  ⚠️ **행을 지우지 않습니다.** 상태 칸 하나만 '대체됨' 으로 바꿉니다.
 *     행이 꼬일 일이 없고, 시트에 그대로 남아 언제든 되살릴 수 있습니다.
 *     화면(미션·계획 탭)에서만 안 보이게 됩니다.
 *
 *  ⚠️ '완료' 한 것은 손대지 않습니다. 실제로 한 일의 기록입니다.
 *
 *  쓰는 법
 *    미리보기   /.netlify/functions/cleanup
 *    실제 정리   /.netlify/functions/cleanup?apply=1
 *
 *  ⚠️ 연월 칸을 보지 않습니다. 숫자로 깨진 줄(46266 같은)도 그냥 정리됩니다.
 *     그래서 repair 를 먼저 돌리지 않아도 됩니다.
 */
const { readTab, updateCells, json } = require("./_google");

const T = {
  name: "콘텐츠계획",
  headers: ["id", "연월", "주차", "주제", "필요한사진", "채널", "상태", "생성일", "완료일"],
};

exports.handler = async (event) => {
  try {
    const 적용 = String(event.queryStringParameters?.apply || "") === "1";
    const rows = await readTab(T.name, T.headers);

    const 정리할것 = [];
    let 완료 = 0, 이미 = 0;
    rows.forEach((r, i) => {
      const 상태 = String(r["상태"] || "").trim();
      if (상태 === "완료")   { 완료++; return; }   // 한 일은 그대로
      if (상태 === "대체됨") { 이미++; return; }   // 이미 정리됨
      정리할것.push({ rowIndex: i, column: "상태", value: "대체됨",
                      주제: String(r["주제"] || "").slice(0, 30) });
    });

    if (!적용) {
      return json(200, {
        미리보기: true,
        전체줄수: rows.length,
        정리할것: 정리할것.length,
        그대로둘것: { 완료, 이미정리됨: 이미 },
        보기: 정리할것.slice(0, 10).map((t) => t.주제),
        안내: "실제로 정리하려면 주소 끝에 ?apply=1 을 붙이세요. 행은 지우지 않고 상태만 바꿉니다",
      });
    }

    const 고침 = await updateCells(T.name, T.headers, 정리할것);
    return json(200, {
      정리함: 고침,
      그대로둔것: { 완료, 이미정리됨: 이미 },
      안내: "앱을 새로고침하면 계획이 비어 있습니다. 「AI에게 계획 제안받기」로 새로 시작하세요",
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
