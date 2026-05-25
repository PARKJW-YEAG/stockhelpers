const axios = require("axios");
const { todayYYYYMMDD, daysAgoYYYYMMDD } = require("../utils/date");

const OPENDART_API_KEY = process.env.OPENDART_API_KEY;
const disclosureCache = new Map();

function hasOpenDartKey() {
  return Boolean(OPENDART_API_KEY && OPENDART_API_KEY.trim() !== "");
}

async function fetchDisclosures(corpCode, days = 180) {
  if (!hasOpenDartKey()) return [];

  const cacheKey = `${corpCode}:${days}`;
  const cached = disclosureCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < 1000 * 60 * 30) {
    return cached.data;
  }

  try {
    const response = await axios.get("https://opendart.fss.or.kr/api/list.json", {
      params: {
        crtfc_key: OPENDART_API_KEY,
        corp_code: corpCode,
        bgn_de: daysAgoYYYYMMDD(days),
        end_de: todayYYYYMMDD(),
        page_no: 1,
        page_count: 20
      },
      timeout: 15000
    });

    const data = response.data;

    if (data.status !== "000" || !Array.isArray(data.list)) {
      disclosureCache.set(cacheKey, {
        fetchedAt: Date.now(),
        data: []
      });
      return [];
    }

    const disclosures = data.list.slice(0, 12).map((item) => {
      const reportName = item.report_nm || "";
      const risk = classifyDisclosureRisk(reportName);

      return {
        date: item.rcept_dt || "-",
        reportName,
        receiptNo: item.rcept_no || "-",
        submitter: item.flr_nm || "-",
        riskLevel: risk.level,
        riskLabel: risk.label,
        comment: risk.comment
      };
    });

    disclosureCache.set(cacheKey, {
      fetchedAt: Date.now(),
      data: disclosures
    });

    return disclosures;
  } catch (error) {
    console.log("공시 조회 실패:", error.message);
    return [];
  }
}

function classifyDisclosureRisk(reportName) {
  const text = String(reportName || "");

  const highRiskKeywords = [
    "유상증자",
    "전환사채",
    "신주인수권부사채",
    "감사의견",
    "횡령",
    "배임",
    "상장폐지",
    "관리종목",
    "불성실공시",
    "회생절차"
  ];

  const mediumRiskKeywords = [
    "최대주주",
    "소송",
    "담보제공",
    "채무보증",
    "타법인주식",
    "영업정지",
    "단기차입"
  ];

  const positiveKeywords = [
    "공급계약",
    "수주",
    "자기주식취득",
    "현금ㆍ현물배당",
    "배당",
    "무상증자"
  ];

  if (highRiskKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: "high",
      label: "고위험",
      comment: "주가 희석, 재무 위험, 상장 리스크와 관련될 수 있어 반드시 원문 확인이 필요합니다."
    };
  }

  if (mediumRiskKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: "medium",
      label: "주의",
      comment: "지배구조, 재무 부담, 사업 변동성과 관련될 수 있습니다."
    };
  }

  if (positiveKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: "positive",
      label: "긍정 가능",
      comment: "실적, 주주환원, 수주 기대와 관련될 수 있으나 계약 규모와 조건 확인이 필요합니다."
    };
  }

  return {
    level: "neutral",
    label: "일반",
    comment: "일반 공시입니다. 투자 판단 전 세부 내용을 확인하세요."
  };
}

module.exports = {
  fetchDisclosures,
  classifyDisclosureRisk
};
