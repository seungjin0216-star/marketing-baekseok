/**
 * 촬영 미션 알림 (주 2회 자동 실행)
 *
 * 이번 주에 아직 안 한 미션이 있으면 문자로 알린다.
 * 알림이 있어야 리듬이 생긴다. 이 앱의 핵심.
 *
 * netlify.toml 의 schedule 설정으로 화요일·금요일 오전 10시(KST)에 실행된다.
 * 수동 확인: /.netlify/functions/notify-mission?test=1
 *
 * 필요한 환경변수
 *   SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_FROM / SOLAPI_TO
 *   (없으면 조용히 건너뛴다)
 */
const crypto = require("node:crypto");
const { readTab, json } = require("./_google");
const CFG = require("./_config");

const T = CFG.TABS.계획;

function nowKST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const weekOfMonth = (d) => Math.min(5, Math.ceil(d.getDate() / 7));

/** 문자 요금 기준 바이트 수 (한글 2바이트) */
function byteLength(s) {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}

async function sendSms(text) {
  const key = (process.env.SOLAPI_API_KEY || "").trim();
  const secret = (process.env.SOLAPI_API_SECRET || "").trim();
  const from = (process.env.SOLAPI_FROM || "").replace(/\D/g, "");
  const to = (process.env.SOLAPI_TO || "").replace(/\D/g, "");
  if (!key || !secret || !from || !to) return "미설정";

  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", secret).update(date + salt).digest("hex");

  // 90바이트까지 SMS(13원), 넘으면 LMS(29원)
  const type = byteLength(text) <= 90 ? "SMS" : "LMS";
  const message = { to, from, text, type };
  if (type === "LMS") message.subject = "콘텐츠 미션";

  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      Authorization: `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });
  const data = await res.json().catch(() => ({}));
  const code = data.statusCode || data.errorCode;
  if (!res.ok || (code && code !== "2000")) {
    throw new Error(`${res.status} ${code || ""} ${data.statusMessage || data.errorMessage || ""}`);
  }
  return `${type} 발송`;
}

// 🔕 26-10-09 사장님: 「현재 솔라피에서 콘텐츠 계획 관련해서 문자가 오는데 문자 기능 잠시 멈추고 알림으로 대체하자」
//    → 꺼 둡니다 (지우지 않음 · 다시 켜려면 true). 대신 사장앱 08:00 점검이 폰 알림으로 보냄
//       (계획 없음 · 월요일 이번 주 미션 · 화·금 남은 미션 — 네이버순위트래커/netlify/functions/_owner.mjs ③)
const SMS_ON = false;

exports.handler = async (event) => {
  if (!SMS_ON) return json(200, { sent: false, reason: "문자 꺼짐 — 사장앱 알림으로 대체 (26-10-09)" });
  try {
    const d = nowKST();
    const 연월 = ym(d);
    const 주차 = weekOfMonth(d);

    const rows = await readTab(T.name, T.headers);
    const 이번달 = rows.filter((r) => r["연월"] === 연월);
    const 남은미션 = 이번달.filter(
      (r) => String(r["주차"]) === String(주차) && r["상태"] !== "완료"
    );

    let msg;
    if (!이번달.length) {
      msg = `[콘텐츠] ${연월} 계획이 아직 없습니다. 앱에서 이달 계획을 세워주세요.`;
    } else if (!남은미션.length) {
      // 이번 주 할 일이 없으면 굳이 문자를 보내지 않는다 (알림 피로 방지)
      return json(200, { sent: false, reason: "이번 주 미션 모두 완료" });
    } else {
      const 목록 = 남은미션
        .slice(0, 2)
        .map((m, i) => `${i + 1}. ${m["필요한사진"] || m["주제"]}`)
        .join("\n");
      msg = `[콘텐츠] ${주차}주차 촬영 ${남은미션.length}건\n${목록}`;
      if (남은미션.length > 2) msg += `\n외 ${남은미션.length - 2}건`;
    }

    const via = await sendSms(msg.slice(0, 900));
    return json(200, { sent: via !== "미설정", via, 주차, 남은: 남은미션.length, 미리보기: msg });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
