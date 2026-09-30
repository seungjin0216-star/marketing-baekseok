/**
 * 구글 시트 읽기·쓰기 공용 모듈 (서비스 계정 인증)
 *
 * API 키는 읽기만 되고 쓰기가 안 되므로 서비스 계정을 쓴다.
 * 외부 패키지 없이 Node 내장 crypto 로 JWT를 서명해 토큰을 받는다.
 *
 * 필요한 환경변수
 *   GOOGLE_CREDENTIALS : 서비스 계정 JSON 전체
 *   SHEET_ID           : 콘텐츠 계획 스프레드시트 ID
 */
const crypto = require("node:crypto");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let cachedToken = null; // { token, expiresAt }

function creds() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 환경변수가 없습니다.");
  return JSON.parse(raw);
}

function base64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** 서비스 계정으로 액세스 토큰 발급 (50분 캐시) */
async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const { client_email, private_key } = creds();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(private_key.replace(/\\n/g, "\n"), "base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`구글 인증 실패: ${JSON.stringify(data).slice(0, 200)}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

const SHEET_ID = () => {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error("SHEET_ID 환경변수가 없습니다.");
  return id;
};

// ══════════════════════════════════════════════════════════════════
//  🔴 valueInputOption 은 반드시 RAW 입니다   2026-09-30
//
//  ⚠️ 그전에는 USER_ENTERED 였습니다. 그러면 **구글이 값을 해석합니다.**
//
//       "2026-09"     →  「2026년 9월」로 보고 숫자 46266 으로 저장
//       "2026-09-30"  →  날짜로 보고 숫자로 저장
//       "2026-09-31"  →  없는 날짜라 글자로 남음   ← 같은 열에 둘이 섞임
//
//     그래서 코드가  r["연월"] === "2026-09"  로 찾으면 **영원히 못 찾습니다.**
//     시트에는 46266 이 들어 있으니까요.
//
//  ⚠️ 저장은 계속 되고 있었습니다. 다만 저장한 것을 다시 못 읽었습니다.
//     화면에는 「저장했다는데 목록이 비어 있다」로 보였고,
//     그걸 「계획이 지워졌다」로 오해해 엉뚱한 곳을 고쳤습니다.
//
//  ⚠️ RAW 는 적은 그대로 넣습니다. 절대 USER_ENTERED 로 되돌리지 마십시오.
//     수식을 넣을 일이 있어도 그 칸만 따로 처리하십시오.
// ══════════════════════════════════════════════════════════════════

async function api(path, options = {}) {
  const token = await getToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}${path}`,
    { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `시트 요청 실패 (${res.status})`);
  return data;
}

/**
 * 다른 스프레드시트의 탭을 읽기 전용으로 가져오기 (순위 트래커용)
 *
 * ⚠️ 그 시트에 이 앱의 서비스 계정이 "뷰어"로 공유돼 있어야 합니다.
 *    공유가 안 돼 있으면 403 이 납니다. 호출하는 쪽에서 잡아서 넘기세요.
 * ⚠️ readTab 과 달리 탭이 없어도 만들지 않습니다. 남의 시트를 건드리지 않습니다.
 */
async function readTabFrom(sheetId, tab) {
  const token = await getToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `시트 읽기 실패 (${res.status})`);
  const values = data.values || [];
  if (values.length < 2) return [];
  const head = values[0];
  return values.slice(1).map((row) => {
    const o = {};
    head.forEach((h, i) => { o[h] = row[i] ?? ""; });
    return o;
  });
}

/** 탭 전체를 객체 배열로 읽기. 탭이 없으면 만들고 빈 배열 반환 */
async function readTab(tab, headers) {
  try {
    const data = await api(`/values/${encodeURIComponent(tab)}`);
    const values = data.values || [];
    if (values.length < 2) return [];
    const head = values[0];
    return values.slice(1).map((row) => {
      const o = {};
      head.forEach((h, i) => { o[h] = row[i] ?? ""; });
      return o;
    });
  } catch (e) {
    if (String(e.message).includes("Unable to parse range")) {
      await createTab(tab, headers);
      return [];
    }
    throw e;
  }
}

async function createTab(tab, headers = []) {
  await api(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
  });
  if (headers.length) {
    await api(`/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW`, {
      method: "POST",
      body: JSON.stringify({ values: [headers] }),
    });
  }
}

/** 한 줄 추가 */
async function appendRow(tab, headers, obj) {
  const rows = await readTab(tab, headers); // 탭이 없으면 여기서 만들어진다
  void rows;
  const row = headers.map((h) => obj[h] ?? "");
  await api(`/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
}

/** 여러 줄 추가 */
async function appendRows(tab, headers, list) {
  if (!list.length) return;
  await readTab(tab, headers);
  await api(`/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: list.map((o) => headers.map((h) => o[h] ?? "")) }),
  });
}

/** 특정 행의 한 칸 수정 (1행은 머리글이므로 rowIndex 0 = 2행) */
async function updateCell(tab, headers, rowIndex, column, value) {
  const col = headers.indexOf(column);
  if (col < 0) throw new Error(`알 수 없는 컬럼: ${column}`);
  const a1 = `${String.fromCharCode(65 + col)}${rowIndex + 2}`;
  await api(`/values/${encodeURIComponent(tab)}!${a1}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [[value]] }),
  });
}

/** 여러 칸을 한 번의 요청으로 고칩니다
 *
 *  ⚠️ 2026-09-30 — updateCell 을 144번 부르면 Netlify 10초 제한에 걸립니다.
 *     API 왕복 한 번에 몰아서 처리합니다.
 *
 *  list: [{ rowIndex, column, value }]   rowIndex 0 = 시트 2행
 */
async function updateCells(tab, headers, list) {
  if (!list.length) return 0;
  await readTab(tab, headers);
  const data = list.map((it) => {
    const col = headers.indexOf(it.column);
    if (col < 0) throw new Error(`알 수 없는 컬럼: ${it.column}`);
    return {
      range: `${tab}!${String.fromCharCode(65 + col)}${it.rowIndex + 2}`,
      values: [[it.value]],
    };
  });
  // ⚠️ 한 번에 너무 많이 보내면 거절당합니다. 200칸씩 끊습니다.
  let 고침 = 0;
  for (let i = 0; i < data.length; i += 200) {
    const 조각 = data.slice(i, i + 200);
    await api(`/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: 조각 }),
    });
    고침 += 조각.length;
  }
  return 고침;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

module.exports = { readTab, readTabFrom, appendRow, appendRows, updateCell, updateCells, json };
