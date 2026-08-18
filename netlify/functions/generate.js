/**
 * 사진 + 미션 → 채널별 글 생성
 *
 *   POST /generate
 *   { 주제, 필요한사진, 메모, 채널:["네이버소식","인스타","당근"], 사진: "data:image/jpeg;base64,..." }
 *
 * 사진은 분석에만 쓰고 저장하지 않는다.
 */
const CFG = require("./_config");
const { json } = require("./_google");
const { getRankBrief } = require("./_rank");

const 채널설명 = {
  네이버소식: `네이버 플레이스 소식글.
- 300~450자
- 검색 노출이 목적이므로 지역 키워드(${CFG.AREA_KEYWORDS.slice(0, 3).join(", ")})와 메뉴명을 자연스럽게 포함
- 해시태그 없음. 문단은 2~3개로 나눌 것
- 손님에게 말 걸듯 담백하게`,

  인스타: `인스타그램 캡션.
- 150~250자 + 해시태그 12~18개
- 첫 줄이 눈길을 끌어야 함 (질문이나 감탄으로 시작)
- 줄바꿈을 넉넉히 써서 읽기 편하게
- 해시태그는 마지막에 한 줄로 모아서. 지역·메뉴·상황 태그를 섞을 것`,

  당근: `당근마켓 비즈프로필 소식.
- 150~250자
- 동네 이웃에게 말하듯 편하고 소박하게. 광고 느낌 최소화
- 이모지 1~2개
- 해시태그 없음`,
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST만 지원합니다." });

    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY 환경변수가 없습니다.");

    const { 주제 = "", 필요한사진 = "", 메모 = "", 채널 = ["네이버소식"], 사진 = "" } =
      JSON.parse(event.body || "{}");

    const 요청채널 = 채널.filter((c) => 채널설명[c]);
    if (!요청채널.length) throw new Error("채널을 하나 이상 선택해주세요.");

    const parts = [];
    let 사진안내 = "사진 없음. 주제와 메모만으로 작성하세요.";
    if (사진 && 사진.startsWith("data:")) {
      const [meta, b64] = 사진.split(",");
      const mime = (meta.match(/data:(.*?);/) || [])[1] || "image/jpeg";
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
      사진안내 = "위 사진을 직접 보고, 실제로 보이는 것만 묘사하세요. 사진에 없는 것을 지어내지 마세요.";
    }

    // 지금 밀리는 키워드를 글에 자연스럽게 녹이도록 알려준다.
    // 트래커가 안 읽혀도 글은 써져야 하므로 실패는 무시한다.
    let 노릴키워드 = "";
    try {
      const brief = await getRankBrief();
      if (brief) {
        const 약한것 = [...(brief.밀림 || []), ...(brief.놓침 || [])]
          .map((x) => x.키워드)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5);
        if (약한것.length) {
          노릴키워드 = `

[지금 순위가 밀리는 키워드 — ${brief.측정일 || "최근"} 기준]
${약한것.join(", ")}
※ 주제와 어울리는 것만 골라 문장에 자연스럽게 넣으세요.
   억지로 다 넣지 마세요. 어색하면 안 넣는 게 낫습니다.`;
        }
      }
    } catch (e) { /* 순위는 있으면 좋은 것일 뿐 */ }

    const prompt = `당신은 '${CFG.FULL_NAME}' 사장님입니다. 아래 조건으로 채널별 글을 써주세요.

[이번 콘텐츠]
주제: ${주제 || "(지정 없음)"}
촬영 지시: ${필요한사진 || "(없음)"}
사장님 메모: ${메모 || "(없음)"}

[사진]
${사진안내}

[가게 정보]
지역: ${CFG.AREA_KEYWORDS.join(", ")}
메뉴: ${CFG.MENU_KEYWORDS.join(", ")}
강점: ${CFG.SELLING_POINTS.join(" / ")}
말투: ${CFG.TONE}
${노릴키워드}

[공통 금지사항]
- 없는 사실을 지어내지 말 것 (가격·이벤트·수상 이력 등)
- "최고", "1위" 같은 과장 표현 금지
- 같은 문장을 채널끼리 그대로 복사하지 말 것. 채널마다 다르게 쓸 것

[채널별 지침]
${요청채널.map((c) => `### ${c}\n${채널설명[c]}`).join("\n\n")}

아래 JSON 형식으로만 답하세요.
{${요청채널.map((c) => `"${c}":"글 내용"`).join(",")}}`;

    parts.push({ text: prompt });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(data?.error?.message || "글 생성 실패");

    return json(200, { 결과: JSON.parse(text), 사진사용: Boolean(사진) });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
