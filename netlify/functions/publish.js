/**
 * 발행 기록 저장
 *
 *   POST /publish
 *   { 주제, 채널, 본문, 사진사용, 계획id }
 *
 * 이 기록이 쌓여야 나중에 "소식글을 올린 주에 순위가 올랐나"를 볼 수 있다.
 */
const { readTab, appendRow, json } = require("./_google");
const CFG = require("./_config");

const T = CFG.TABS.발행;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const rows = await readTab(T.name, T.headers);
      return json(200, { rows: rows.slice(-30).reverse() });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "지원하지 않는 요청입니다." });

    const { 주제 = "", 채널 = "", 본문 = "", 사진사용 = false, 계획id = "" } =
      JSON.parse(event.body || "{}");
    if (!본문) throw new Error("본문이 비어 있습니다.");

    const rows = await readTab(T.name, T.headers);
    const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);

    await appendRow(T.name, T.headers, {
      id: rows.length + 1,
      날짜: now,
      지점: CFG.BRANCH,
      주제,
      채널,
      본문: 본문.slice(0, 2000),
      사진사용: 사진사용 ? "Y" : "N",
      계획id,
    });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
