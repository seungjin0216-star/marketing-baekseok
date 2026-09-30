/**
 * 🔧 시트 고치기 — 날짜로 변해버린 칸을 글자로 되돌립니다   2026-09-30
 *
 *  ⚠️ 왜 필요한가
 *    그전에는 valueInputOption=USER_ENTERED 로 저장해서
 *    구글이 "2026-09" 를 날짜로 해석해 숫자 46266 으로 바꿔버렸습니다.
 *    그래서 코드가 그 줄을 영영 못 찾았습니다.
 *
 *  쓰는 법
 *    미리보기   /.netlify/functions/repair
 *    실제 고침   /.netlify/functions/repair?apply=1
 *
 *  ⚠️ 아무것도 지우지 않습니다. 숫자를 원래 글자로 되돌리기만 합니다.
 *  ⚠️ 먼저 미리보기로 무엇이 바뀔지 보십시오.
 */
const { readTab, updateCell, json } = require("./_google");

const T = {
  name: "콘텐츠계획",
  headers: ["id", "연월", "주차", "주제", "필요한사진", "채널", "상태", "생성일", "완료일"],
};

/** 구글 시트 일련번호(1899-12-30 기준)를 날짜로 */
function 번호를날짜로(n) {
  const ms = (Number(n) - 25569) * 86400 * 1000;   // 1970-01-01 기준으로 옮김
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, "0");
  return { 연월: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`,
           전체: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` };
}

exports.handler = async (event) => {
  try {
    const 적용 = String(event.queryStringParameters?.apply || "") === "1";
    const rows = await readTab(T.name, T.headers);
    const 할일 = [];

    rows.forEach((r, i) => {
      ["연월", "생성일", "완료일"].forEach((칸) => {
        const v = String(r[칸] ?? "").trim();
        if (!v || !/^\d+$/.test(v)) return;          // 숫자만 손봅니다
        const d = 번호를날짜로(v);
        if (!d) return;
        할일.push({ 줄: i + 2, 칸, 전: v, 후: 칸 === "연월" ? d.연월 : d.전체, i });
      });
    });

    if (!적용) {
      return json(200, {
        미리보기: true,
        고칠것: 할일.length,
        보기: 할일.slice(0, 20),
        안내: "실제로 고치려면 주소 끝에 ?apply=1 을 붙이세요",
      });
    }

    let 고침 = 0, 실패 = 0;
    for (const t of 할일) {
      try { await updateCell(T.name, T.headers, t.i, t.칸, t.후); 고침++; }
      catch (e) { 실패++; }
    }
    return json(200, { 고침, 실패, 전체: 할일.length });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
