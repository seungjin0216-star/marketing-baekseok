/**
 * 우리 매장 정보 — 순위트래커 시트의 「우리매장」 탭
 *
 * 왜 필요한가
 *   여태 마케팅앱은 **우리가 뭘 파는지도 모르는 채로** 글을 썼다.
 *   메뉴 이름도 가격도 소개글도 몰라서 "맛있는 곱창" 같은 뻔한 문장만 나왔다.
 *   이제 실제 메뉴 이름과 소개글을 읽어서 쓴다.
 *
 * 시트 모양 (crawler/sheets.py 의 save_place_info 가 만든다)
 *   갱신일 | 구분 | 이름 | 내용 | 값
 *   ─────────────────────────────────────────
 *   기본정보  별점                        4.87
 *   소개글          안녕하세요 / 일산 백석역…
 *   대표키워드      일산곱창, 백석동곱창…
 *   메뉴      곱창구이   고소함             24000
 *   소식글    설 휴무    안녕하세요…        20260211
 *   POS       객단가                      85211
 *
 * ⚠️ 이 파일은 절대 예외를 위로 던지지 않는다.
 *    매장 정보를 못 읽어도 글은 써져야 한다. 있으면 좋은 것이지 없으면 멈추는 것이 아니다.
 */
const { readTabFrom } = require("./_google");
const CFG = require("./_config");

const TAB = "우리매장";

function 골라내기(rows, 구분) {
  return rows.filter((r) => String(r["구분"] || "").trim() === 구분);
}

function 값하나(rows, 구분, 이름) {
  const r = 골라내기(rows, 구분).find((x) => String(x["이름"] || "").trim() === 이름);
  if (!r) return "";
  // 숫자류는 「값」 칸에, 글자류는 「내용」 칸에 들어 있다
  return String(r["값"] || r["내용"] || "").trim();
}

/**
 * @returns {null|{소개글,메뉴[],소식글[],대표키워드[],기본정보,갱신일,사유?}}
 *          연결이 안 됐거나 데이터가 없으면 null
 */
async function getPlaceInfo() {
  const R = CFG.RANK || {};
  if (!R.sheetId) return null;              // 순위트래커와 같은 시트를 쓴다

  let rows;
  try {
    rows = await readTabFrom(R.sheetId, TAB);
  } catch (e) {
    return { 사유: `매장 정보를 못 읽었습니다 — ${e.message}` };
  }
  if (!rows || !rows.length) {
    return { 사유: "「우리매장」 탭이 비어 있습니다. 크롤러를 한 번 돌리세요." };
  }

  const 메뉴 = 골라내기(rows, "메뉴").map((r) => ({
    이름: String(r["이름"] || "").trim(),
    설명: String(r["내용"] || "").trim(),
    가격: String(r["값"] || "").trim(),
  })).filter((m) => m.이름);

  const 소식글 = 골라내기(rows, "소식글").map((r) => ({
    제목: String(r["이름"] || "").trim(),
    본문: String(r["내용"] || "").trim(),
    날짜: String(r["값"] || "").trim(),
  })).filter((f) => f.제목);

  const 소개글 = (골라내기(rows, "소개글")[0] || {})["내용"] || "";
  const 대표키워드 = String((골라내기(rows, "대표키워드")[0] || {})["내용"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  return {
    갱신일: String(rows[0]["갱신일"] || "").trim(),
    소개글: String(소개글).trim(),
    대표키워드,
    메뉴,
    소식글,
    기본정보: {
      이름: 값하나(rows, "기본정보", "이름"),
      별점: 값하나(rows, "기본정보", "별점"),
      방문자리뷰: 값하나(rows, "기본정보", "방문자리뷰"),
      편의시설: 값하나(rows, "기본정보", "편의시설"),
      오시는길: 값하나(rows, "기본정보", "오시는길"),
    },
  };
}

/**
 * AI 프롬프트에 넣을 문장으로 만든다.
 *
 * 소개글 전문(1800자)을 통째로 넣으면 프롬프트가 그것에 끌려간다.
 * 앞부분만 잘라 "우리가 어떤 집인지"만 알려주고, 메뉴는 이름과 가격 위주로 준다.
 */
function 프롬프트문장(info, opts) {
  if (!info || info.사유 || !info.메뉴) return "";
  const o = opts || {};
  const p = [];

  if (info.소개글) {
    p.push("[우리 가게 소개 — 사장님이 직접 쓴 글]");
    p.push(info.소개글.slice(0, o.소개글길이 || 600));
    p.push("");
  }

  if (info.메뉴.length) {
    p.push("[실제 메뉴 — 이름을 그대로 쓰세요]");
    info.메뉴.slice(0, 12).forEach((m) => {
      const 가격 = m.가격 ? `${Number(m.가격).toLocaleString()}원` : "";
      p.push(`- ${m.이름}${가격 ? " (" + 가격 + ")" : ""}${m.설명 ? " — " + m.설명 : ""}`);
    });
    p.push("※ 메뉴 이름을 지어내지 마세요. 위 목록에 있는 것만 씁니다.");
    p.push("");
  }

  if (info.소식글.length) {
    const 최근 = info.소식글.slice(0, 5);
    p.push("[최근 올린 소식글 — 겹치지 않게]");
    최근.forEach((f) => p.push(`- ${f.날짜} ${f.제목}`));
    p.push("");
  }

  const b = info.기본정보 || {};
  const 조각 = [];
  if (b.별점) 조각.push(`별점 ${b.별점}`);
  if (b.방문자리뷰) 조각.push(`방문자리뷰 ${Number(b.방문자리뷰).toLocaleString()}`);
  if (b.편의시설) 조각.push(`편의시설: ${b.편의시설}`);
  if (조각.length) {
    p.push("[사실 관계 — 지어내지 말고 이 값만 쓰세요]");
    p.push(조각.join(" · "));
    p.push("");
  }

  return p.join("\n").trim();
}

/** 며칠째 소식글이 없는지 — 없으면 null */
function 소식공백일수(info) {
  if (!info || !info.소식글 || !info.소식글.length) return null;
  const d = String(info.소식글[0].날짜 || "");
  if (!/^\d{8}$/.test(d)) return null;
  const last = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00`);
  return Math.floor((Date.now() - last.getTime()) / 86400000);
}

module.exports = { getPlaceInfo, 프롬프트문장, 소식공백일수 };
