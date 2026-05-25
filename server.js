const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { parseStringPromise } = require("xml2js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENDART_API_KEY = process.env.OPENDART_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let corpListCache = null;
let corpListFetchedAt = 0;
const financeCache = new Map();
const marketCache = new Map();
const disclosureCache = new Map();

const REPORT_CODE = {
  ANNUAL: "11011"
};

function hasOpenDartKey() {
  return Boolean(OPENDART_API_KEY && OPENDART_API_KEY.trim() !== "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function todayYYYYMMDD() {
  const now = new Date();
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

function daysAgoYYYYMMDD(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function cleanNumber(value) {
  if (value === undefined || value === null) return null;

  let text = String(value)
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .trim();

  if (!text || text === "-") return null;

  let isNegativeByParentheses = false;

  if (text.startsWith("(") && text.endsWith(")")) {
    isNegativeByParentheses = true;
    text = text.replace(/[()]/g, "");
  }

  const number = Number(text);

  if (!Number.isFinite(number)) return null;

  return isNegativeByParentheses ? -number : number;
}

function toNumber(value) {
  if (value === undefined || value === null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "object" && value.raw !== undefined) {
    return toNumber(value.raw);
  }

  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function formatWon(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }

  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 1000000000000) {
    return sign + (abs / 1000000000000).toFixed(1) + "조";
  }

  if (abs >= 100000000) {
    return sign + (abs / 100000000).toFixed(1) + "억";
  }

  return sign + abs.toLocaleString("ko-KR") + "원";
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }

  return value.toFixed(1) + "%";
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }

  return Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: digits
  });
}

function formatMarketMoney(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }

  if (currency === "KRW") {
    return formatWon(value);
  }

  if (currency === "USD") {
    const abs = Math.abs(value);

    if (abs >= 1000000000000) {
      return "$" + (abs / 1000000000000).toFixed(2) + "T";
    }

    if (abs >= 1000000000) {
      return "$" + (abs / 1000000000).toFixed(2) + "B";
    }

    if (abs >= 1000000) {
      return "$" + (abs / 1000000).toFixed(2) + "M";
    }

    return "$" + value.toLocaleString("en-US");
  }

  return value.toLocaleString("ko-KR") + " " + (currency || "");
}

function divide(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return a / b;
}

function growthRate(latest, previous) {
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }

  return ((latest - previous) / Math.abs(previous)) * 100;
}

function findAccount(rows, keywords) {
  for (const keyword of keywords) {
    const found = rows.find((row) => {
      const accountName = row.account_nm || "";
      const accountId = row.account_id || "";

      return accountName === keyword || accountId === keyword;
    });

    if (found) return found;
  }

  for (const keyword of keywords) {
    const found = rows.find((row) => {
      const accountName = row.account_nm || "";
      return accountName.includes(keyword);
    });

    if (found) return found;
  }

  return null;
}

async function loadCorpList() {
  if (!hasOpenDartKey()) {
    throw new Error("OPENDART_API_KEY가 Render 환경변수에 없습니다.");
  }

  const oneDay = 24 * 60 * 60 * 1000;

  if (corpListCache && Date.now() - corpListFetchedAt < oneDay) {
    return corpListCache;
  }

  const response = await axios.get("https://opendart.fss.or.kr/api/corpCode.xml", {
    params: {
      crtfc_key: OPENDART_API_KEY
    },
    responseType: "arraybuffer",
    timeout: 20000
  });

  const zip = new AdmZip(response.data);
  const entries = zip.getEntries();

  const corpCodeFile = entries.find((entry) =>
    entry.entryName.toLowerCase().includes("corpcode")
  );

  if (!corpCodeFile) {
    throw new Error("OpenDART 고유번호 ZIP 안에서 CORPCODE.xml을 찾지 못했습니다.");
  }

  const xml = corpCodeFile.getData().toString("utf8");

  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true
  });

  const rawList = parsed.result.list;
  const list = Array.isArray(rawList) ? rawList : [rawList];

  corpListCache = list
    .filter((corp) => corp.stock_code && corp.stock_code.trim() !== "")
    .map((corp) => ({
      corpCode: corp.corp_code,
      corpName: corp.corp_name,
      stockCode: corp.stock_code
    }));

  corpListFetchedAt = Date.now();

  return corpListCache;
}

function findCompany(corpList, query) {
  const input = String(query).trim().toUpperCase();

  const byStockCode = corpList.find((corp) => corp.stockCode === input);
  if (byStockCode) return byStockCode;

  const byExactName = corpList.find(
    (corp) => corp.corpName.toUpperCase() === input
  );
  if (byExactName) return byExactName;

  const byPartialName = corpList.find((corp) =>
    corp.corpName.toUpperCase().includes(input)
  );
  if (byPartialName) return byPartialName;

  return null;
}

function searchCompanies(corpList, query, limit = 10) {
  const input = String(query || "").trim().toUpperCase();

  if (!input) return [];

  const scored = corpList
    .map((corp) => {
      const name = corp.corpName.toUpperCase();
      const code = corp.stockCode;

      let score = 0;

      if (code === input) score += 100;
      if (name === input) score += 90;
      if (code.startsWith(input)) score += 70;
      if (name.startsWith(input)) score += 60;
      if (name.includes(input)) score += 40;

      return {
        ...corp,
        score
      };
    })
    .filter((corp) => corp.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((corp) => ({
    name: corp.corpName,
    code: corp.stockCode,
    corpCode: corp.corpCode
  }));
}

function getSectorProfile(companyName) {
  const name = String(companyName || "").toUpperCase();

  if (
    name.includes("은행") ||
    name.includes("금융") ||
    name.includes("지주") ||
    name.includes("보험") ||
    name.includes("증권")
  ) {
    return {
      key: "finance",
      label: "금융",
      roeGood: 10,
      roeOkay: 6,
      marginGood: 0,
      marginOkay: 0,
      debtGood: 300,
      debtOkay: 700,
      debtWarn: 1200,
      perGood: 8,
      perOkay: 14,
      perHigh: 20,
      pbrGood: 0.7,
      pbrOkay: 1.2,
      pbrHigh: 2
    };
  }

  if (
    name.includes("바이오") ||
    name.includes("제약") ||
    name.includes("셀트리온") ||
    name.includes("헬스") ||
    name.includes("메디")
  ) {
    return {
      key: "bio",
      label: "바이오/제약",
      roeGood: 8,
      roeOkay: 3,
      marginGood: 12,
      marginOkay: 3,
      debtGood: 50,
      debtOkay: 120,
      debtWarn: 200,
      perGood: 25,
      perOkay: 45,
      perHigh: 80,
      pbrGood: 2,
      pbrOkay: 5,
      pbrHigh: 10
    };
  }

  if (
    name.includes("NAVER") ||
    name.includes("카카오") ||
    name.includes("엔씨") ||
    name.includes("게임") ||
    name.includes("소프트") ||
    name.includes("플랫폼")
  ) {
    return {
      key: "platform",
      label: "플랫폼/IT",
      roeGood: 12,
      roeOkay: 6,
      marginGood: 18,
      marginOkay: 8,
      debtGood: 70,
      debtOkay: 150,
      debtWarn: 250,
      perGood: 20,
      perOkay: 35,
      perHigh: 60,
      pbrGood: 2,
      pbrOkay: 4,
      pbrHigh: 8
    };
  }

  if (
    name.includes("전자") ||
    name.includes("하이닉스") ||
    name.includes("반도체") ||
    name.includes("DB하이텍") ||
    name.includes("리노공업")
  ) {
    return {
      key: "semiconductor",
      label: "반도체/전자",
      roeGood: 12,
      roeOkay: 6,
      marginGood: 15,
      marginOkay: 5,
      debtGood: 80,
      debtOkay: 150,
      debtWarn: 250,
      perGood: 12,
      perOkay: 25,
      perHigh: 40,
      pbrGood: 1.2,
      pbrOkay: 2.5,
      pbrHigh: 5
    };
  }

  if (
    name.includes("건설") ||
    name.includes("산업개발") ||
    name.includes("대우건설") ||
    name.includes("현대건설")
  ) {
    return {
      key: "construction",
      label: "건설",
      roeGood: 10,
      roeOkay: 5,
      marginGood: 8,
      marginOkay: 3,
      debtGood: 120,
      debtOkay: 250,
      debtWarn: 400,
      perGood: 8,
      perOkay: 14,
      perHigh: 25,
      pbrGood: 0.8,
      pbrOkay: 1.5,
      pbrHigh: 3
    };
  }

  if (
    name.includes("마트") ||
    name.includes("쇼핑") ||
    name.includes("백화점") ||
    name.includes("유통") ||
    name.includes("이마트") ||
    name.includes("롯데쇼핑")
  ) {
    return {
      key: "retail",
      label: "유통",
      roeGood: 8,
      roeOkay: 4,
      marginGood: 7,
      marginOkay: 3,
      debtGood: 100,
      debtOkay: 200,
      debtWarn: 350,
      perGood: 10,
      perOkay: 18,
      perHigh: 30,
      pbrGood: 0.8,
      pbrOkay: 1.5,
      pbrHigh: 3
    };
  }

  return {
    key: "general",
    label: "일반 제조/기타",
    roeGood: 12,
    roeOkay: 6,
    marginGood: 12,
    marginOkay: 5,
    debtGood: 100,
    debtOkay: 200,
    debtWarn: 350,
    perGood: 12,
    perOkay: 22,
    perHigh: 35,
    pbrGood: 1,
    pbrOkay: 2,
    pbrHigh: 4
  };
}

async function fetchFinancialStatementForYear(corpCode, year) {
  if (!hasOpenDartKey()) {
    throw new Error("OPENDART_API_KEY가 Render 환경변수에 없습니다.");
  }

  for (const fsDiv of ["CFS", "OFS"]) {
    const cacheKey = `${corpCode}:${year}:${fsDiv}`;

    if (financeCache.has(cacheKey)) {
      return financeCache.get(cacheKey);
    }

    try {
      const response = await axios.get(
        "https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json",
        {
          params: {
            crtfc_key: OPENDART_API_KEY,
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code: REPORT_CODE.ANNUAL,
            fs_div: fsDiv
          },
          timeout: 20000
        }
      );

      const data = response.data;

      if (
        data.status === "000" &&
        Array.isArray(data.list) &&
        data.list.length > 0
      ) {
        const result = {
          year,
          fsDiv,
          rows: data.list
        };

        financeCache.set(cacheKey, result);
        return result;
      }

      financeCache.set(cacheKey, null);
    } catch (error) {
      console.log(`OpenDART 재무제표 조회 실패: ${year} ${fsDiv}`, error.message);
      financeCache.set(cacheKey, null);
    }
  }

  return null;
}

async function fetchRecentFinancialStatements(corpCode, targetCount = 5) {
  const currentYear = new Date().getFullYear();

  const candidateYears = [
    currentYear - 1,
    currentYear - 2,
    currentYear - 3,
    currentYear - 4,
    currentYear - 5,
    currentYear - 6,
    currentYear - 7,
    currentYear - 8
  ];

  const statements = [];

  for (const year of candidateYears) {
    const statement = await fetchFinancialStatementForYear(corpCode, year);

    if (statement) {
      statements.push(statement);
    }

    if (statements.length >= targetCount) {
      break;
    }
  }

  return statements;
}

function extractMetrics(rows) {
  const revenueRow = findAccount(rows, [
    "ifrs-full_Revenue",
    "ifrs-full_RevenueFromContractsWithCustomersExcludingAssessedTax",
    "dart_OperatingRevenue",
    "매출액",
    "수익(매출액)",
    "영업수익"
  ]);

  const operatingProfitRow = findAccount(rows, [
    "dart_OperatingIncomeLoss",
    "영업이익",
    "영업이익(손실)",
    "영업손익"
  ]);

  const netProfitRow = findAccount(rows, [
    "ifrs-full_ProfitLoss",
    "당기순이익",
    "당기순이익(손실)",
    "분기순이익",
    "반기순이익"
  ]);

  const assetRow = findAccount(rows, [
    "ifrs-full_Assets",
    "자산총계",
    "자산 총계"
  ]);

  const liabilityRow = findAccount(rows, [
    "ifrs-full_Liabilities",
    "부채총계",
    "부채 총계"
  ]);

  const equityRow = findAccount(rows, [
    "ifrs-full_Equity",
    "ifrs-full_EquityAttributableToOwnersOfParent",
    "자본총계",
    "자본 총계",
    "지배기업의 소유주에게 귀속되는 자본"
  ]);

  const revenue = cleanNumber(revenueRow?.thstrm_amount);
  const operatingProfit = cleanNumber(operatingProfitRow?.thstrm_amount);
  const netProfit = cleanNumber(netProfitRow?.thstrm_amount);
  const assets = cleanNumber(assetRow?.thstrm_amount);
  const liabilities = cleanNumber(liabilityRow?.thstrm_amount);
  const equity = cleanNumber(equityRow?.thstrm_amount);

  const roeRaw = divide(netProfit, equity);
  const debtRatioRaw = divide(liabilities, equity);
  const operatingMarginRaw = divide(operatingProfit, revenue);
  const netMarginRaw = divide(netProfit, revenue);

  return {
    raw: {
      revenue,
      operatingProfit,
      netProfit,
      assets,
      liabilities,
      equity
    },
    metrics: {
      roe: formatPercent(roeRaw === null ? null : roeRaw * 100),
      debtRatio: formatPercent(debtRatioRaw === null ? null : debtRatioRaw * 100),
      operatingMargin: formatPercent(
        operatingMarginRaw === null ? null : operatingMarginRaw * 100
      ),
      netMargin: formatPercent(netMarginRaw === null ? null : netMarginRaw * 100)
    },
    calculated: {
      roe: roeRaw === null ? null : roeRaw * 100,
      debtRatio: debtRatioRaw === null ? null : debtRatioRaw * 100,
      operatingMargin: operatingMarginRaw === null ? null : operatingMarginRaw * 100,
      netMargin: netMarginRaw === null ? null : netMarginRaw * 100
    }
  };
}

function makeFinancialsFromStatements(statements) {
  return statements.map((statement) => {
    const extracted = extractMetrics(statement.rows);

    return {
      year: String(statement.year),
      fsDiv: statement.fsDiv === "CFS" ? "연결" : "별도",
      revenue: formatWon(extracted.raw.revenue),
      operatingProfit: formatWon(extracted.raw.operatingProfit),
      netProfit: formatWon(extracted.raw.netProfit),
      roe: extracted.metrics.roe,
      debtRatio: extracted.metrics.debtRatio,
      operatingMargin: extracted.metrics.operatingMargin,
      rawRevenue: extracted.raw.revenue,
      rawOperatingProfit: extracted.raw.operatingProfit,
      rawNetProfit: extracted.raw.netProfit,
      rawAssets: extracted.raw.assets,
      rawLiabilities: extracted.raw.liabilities,
      rawEquity: extracted.raw.equity,
      rawRoe: extracted.calculated.roe,
      rawDebtRatio: extracted.calculated.debtRatio,
      rawOperatingMargin: extracted.calculated.operatingMargin
    };
  });
}

function makeYahooSymbolCandidates(stockCodeOrTicker) {
  const input = String(stockCodeOrTicker).trim().toUpperCase();

  if (/^[0-9]{6}$/.test(input)) {
    return [input + ".KS", input + ".KQ"];
  }

  return [input];
}

async function fetchMarketData(stockCodeOrTicker) {
  const input = String(stockCodeOrTicker).trim().toUpperCase();
  const cached = marketCache.get(input);

  if (cached && Date.now() - cached.fetchedAt < 1000 * 60 * 10) {
    return cached.data;
  }

  const candidates = makeYahooSymbolCandidates(stockCodeOrTicker);

  for (const symbol of candidates) {
    try {
      const response = await axios.get(
        "https://query1.finance.yahoo.com/v7/finance/quote",
        {
          params: {
            symbols: symbol
          },
          timeout: 15000,
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        }
      );

      const result = response.data?.quoteResponse?.result?.[0];

      if (!result) {
        continue;
      }

      const currentPrice = toNumber(result.regularMarketPrice);
      const currency = result.currency || null;
      const marketCap = toNumber(result.marketCap);
      const per = toNumber(result.trailingPE);
      const pbr = toNumber(result.priceToBook);

      const dividendYieldRaw =
        toNumber(result.trailingAnnualDividendYield) ||
        toNumber(result.dividendYield);

      const marketData = {
        symbol,
        currency,
        raw: {
          currentPrice,
          marketCap,
          per,
          pbr,
          dividendYield: dividendYieldRaw
        },
        display: {
          currentPrice:
            currentPrice === null
              ? "-"
              : currency === "KRW"
                ? currentPrice.toLocaleString("ko-KR") + "원"
                : formatMarketMoney(currentPrice, currency),
          marketCap: formatMarketMoney(marketCap, currency),
          per: per === null ? "-" : formatNumber(per, 2),
          pbr: pbr === null ? "-" : formatNumber(pbr, 2),
          dividendYield:
            dividendYieldRaw === null
              ? "-"
              : dividendYieldRaw > 1
                ? dividendYieldRaw.toFixed(2) + "%"
                : (dividendYieldRaw * 100).toFixed(2) + "%"
        }
      };

      marketCache.set(input, {
        fetchedAt: Date.now(),
        data: marketData
      });

      return marketData;
    } catch (error) {
      console.log("Yahoo Finance 직접 조회 실패:", symbol, error.message);
    }
  }

  return null;
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

function detectRiskSignals(calculated, marketData, financials, disclosures) {
  const risks = [];

  if (calculated.roe !== null && calculated.roe < 5) {
    risks.push({
      level: "medium",
      title: "ROE 낮음",
      description: "자본 대비 이익 창출력이 약합니다. 일시적 부진인지 구조적 저수익인지 확인해야 합니다."
    });
  }

  if (calculated.roe !== null && calculated.roe < 0) {
    risks.push({
      level: "high",
      title: "ROE 마이너스",
      description: "적자 또는 자본 훼손 가능성이 있습니다."
    });
  }

  if (calculated.operatingMargin !== null && calculated.operatingMargin < 3) {
    risks.push({
      level: "medium",
      title: "영업이익률 낮음",
      description: "본업 수익성이 약합니다. 가격 경쟁, 원가 상승, 고정비 부담을 확인해야 합니다."
    });
  }

  if (calculated.operatingMargin !== null && calculated.operatingMargin < 0) {
    risks.push({
      level: "high",
      title: "영업손실",
      description: "본업에서 손실이 발생하고 있습니다. 흑자 전환 가능성을 보수적으로 봐야 합니다."
    });
  }

  if (calculated.debtRatio !== null && calculated.debtRatio > 200) {
    risks.push({
      level: "high",
      title: "부채비율 높음",
      description: "금리, 차입금 만기, 이자비용 부담을 확인해야 합니다."
    });
  }

  if (Array.isArray(financials) && financials.length >= 2) {
    const latest = financials[0];
    const previous = financials[1];

    const revenueGrowth = growthRate(latest.rawRevenue, previous.rawRevenue);
    const operatingProfitGrowth = growthRate(
      latest.rawOperatingProfit,
      previous.rawOperatingProfit
    );

    if (revenueGrowth !== null && revenueGrowth < -10) {
      risks.push({
        level: "medium",
        title: "매출 감소",
        description: `최근 매출이 전년 대비 ${Math.abs(revenueGrowth).toFixed(1)}% 감소했습니다. 성장성 둔화 여부 확인이 필요합니다.`
      });
    }

    if (operatingProfitGrowth !== null && operatingProfitGrowth < -20) {
      risks.push({
        level: "high",
        title: "영업이익 급감",
        description: `최근 영업이익이 전년 대비 ${Math.abs(operatingProfitGrowth).toFixed(1)}% 감소했습니다. 일회성인지 구조적인지 확인해야 합니다.`
      });
    }

    if (
      Number.isFinite(latest.rawNetProfit) &&
      Number.isFinite(previous.rawNetProfit) &&
      latest.rawNetProfit < 0 &&
      previous.rawNetProfit > 0
    ) {
      risks.push({
        level: "high",
        title: "순이익 적자 전환",
        description: "순이익이 흑자에서 적자로 전환되었습니다. 비용, 손상차손, 영업외손익을 확인해야 합니다."
      });
    }
  }

  if (marketData && marketData.raw) {
    if (marketData.raw.per !== null && marketData.raw.per > 40) {
      risks.push({
        level: "medium",
        title: "PER 높음",
        description: "현재 이익 대비 가격 부담이 큽니다. 성장성이 이를 정당화하는지 확인해야 합니다."
      });
    }

    if (marketData.raw.pbr !== null && marketData.raw.pbr > 5) {
      risks.push({
        level: "medium",
        title: "PBR 높음",
        description: "자산가치 대비 가격 부담이 있습니다. 고ROE가 유지되는지 확인해야 합니다."
      });
    }
  }

  const riskyDisclosures = (disclosures || []).filter(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  );

  riskyDisclosures.slice(0, 3).forEach((item) => {
    risks.push({
      level: item.riskLevel,
      title: `주의 공시: ${item.riskLabel}`,
      description: `${item.reportName} - ${item.comment}`
    });
  });

  if (risks.length === 0) {
    risks.push({
      level: "low",
      title: "즉시 확인되는 주요 위험 신호 적음",
      description: "현재 지표상 강한 위험 신호는 많지 않습니다. 다만 업종 리스크와 최신 공시는 별도로 확인해야 합니다."
    });
  }

  return risks;
}

function scoreProfitability(calculated, sectorProfile) {
  let score = 50;
  const reasons = [];

  if (calculated.roe === null) {
    reasons.push("ROE 데이터가 없어 수익성 점수는 보수적으로 계산했습니다.");
  } else if (calculated.roe >= sectorProfile.roeGood) {
    score += 25;
    reasons.push(`ROE가 ${sectorProfile.roeGood}% 이상으로 업종 기준상 양호합니다.`);
  } else if (calculated.roe >= sectorProfile.roeOkay) {
    score += 10;
    reasons.push("ROE가 업종 기준상 보통 수준입니다.");
  } else if (calculated.roe >= 0) {
    score -= 15;
    reasons.push("ROE가 낮아 자본 효율성이 약합니다.");
  } else {
    score -= 35;
    reasons.push("ROE가 마이너스입니다.");
  }

  if (sectorProfile.marginGood === 0) {
    reasons.push("금융업 등 일부 업종은 영업이익률 비교 의미가 낮아 ROE 중심으로 판단했습니다.");
  } else if (calculated.operatingMargin === null) {
    score -= 3;
    reasons.push("영업이익률 데이터가 없어 본업 수익성 판단이 제한됩니다.");
  } else if (calculated.operatingMargin >= sectorProfile.marginGood) {
    score += 20;
    reasons.push("영업이익률이 업종 기준상 우수합니다.");
  } else if (calculated.operatingMargin >= sectorProfile.marginOkay) {
    score += 8;
    reasons.push("영업이익률이 업종 기준상 보통 수준입니다.");
  } else if (calculated.operatingMargin >= 0) {
    score -= 12;
    reasons.push("영업이익률이 낮아 본업 수익성이 약합니다.");
  } else {
    score -= 25;
    reasons.push("영업손실 상태입니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreStability(calculated, sectorProfile) {
  let score = 60;
  const reasons = [];

  if (calculated.debtRatio === null) {
    score -= 5;
    reasons.push("부채비율 데이터가 없어 안정성 판단이 제한됩니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtGood) {
    score += 25;
    reasons.push("부채비율이 업종 기준상 안정적입니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtOkay) {
    score += 10;
    reasons.push("부채비율이 업종 기준상 보통 수준입니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtWarn) {
    score -= 10;
    reasons.push("부채비율이 높아 차입 부담 확인이 필요합니다.");
  } else {
    score -= 30;
    reasons.push("부채비율이 매우 높습니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreGrowth(financials) {
  let score = 50;
  const reasons = [];

  if (!Array.isArray(financials) || financials.length < 2) {
    reasons.push("비교 가능한 과거 재무 데이터가 부족해 성장성 점수는 중립으로 계산했습니다.");
    return {
      score,
      reasons
    };
  }

  const latest = financials[0];
  const previous = financials[1];

  const revenueGrowth = growthRate(latest.rawRevenue, previous.rawRevenue);
  const operatingProfitGrowth = growthRate(
    latest.rawOperatingProfit,
    previous.rawOperatingProfit
  );

  if (revenueGrowth === null) {
    reasons.push("매출 성장률 계산이 제한됩니다.");
  } else if (revenueGrowth >= 20) {
    score += 20;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 5) {
    score += 10;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 0) {
    score += 2;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 15;
    reasons.push(`최근 매출이 전년 대비 ${Math.abs(revenueGrowth).toFixed(1)}% 감소했습니다.`);
  }

  if (operatingProfitGrowth === null) {
    reasons.push("영업이익 성장률 계산이 제한됩니다.");
  } else if (operatingProfitGrowth >= 30) {
    score += 25;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 10) {
    score += 15;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 0) {
    score += 3;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 20;
    reasons.push(`최근 영업이익이 전년 대비 ${Math.abs(operatingProfitGrowth).toFixed(1)}% 감소했습니다.`);
  }

  if (financials.length >= 3) {
    const first = financials[0];
    const second = financials[1];
    const third = financials[2];

    if (
      Number.isFinite(first.rawRevenue) &&
      Number.isFinite(second.rawRevenue) &&
      Number.isFinite(third.rawRevenue)
    ) {
      if (first.rawRevenue > second.rawRevenue && second.rawRevenue > third.rawRevenue) {
        score += 8;
        reasons.push("최근 3년 매출이 연속 증가했습니다.");
      } else if (first.rawRevenue < second.rawRevenue && second.rawRevenue < third.rawRevenue) {
        score -= 8;
        reasons.push("최근 3년 매출이 연속 감소했습니다.");
      }
    }
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreValuation(marketData, sectorProfile) {
  let score = 50;
  const reasons = [];

  if (!marketData || !marketData.raw) {
    reasons.push("시세 데이터가 없어 밸류에이션 점수는 중립으로 계산했습니다.");
    return {
      score,
      reasons
    };
  }

  const per = marketData.raw.per;
  const pbr = marketData.raw.pbr;

  if (per === null || per <= 0) {
    reasons.push("PER 데이터가 없거나 적자 구간이라 PER 판단이 제한됩니다.");
  } else if (per <= sectorProfile.perGood) {
    score += 18;
    reasons.push("PER이 업종 기준상 낮은 편입니다. 단, 이익 감소형 저PER인지 확인해야 합니다.");
  } else if (per <= sectorProfile.perOkay) {
    score += 8;
    reasons.push("PER이 업종 기준상 무난한 수준입니다.");
  } else if (per <= sectorProfile.perHigh) {
    score -= 5;
    reasons.push("PER이 다소 높은 편입니다.");
  } else {
    score -= 20;
    reasons.push("PER이 높아 밸류에이션 부담이 큽니다.");
  }

  if (pbr === null || pbr <= 0) {
    reasons.push("PBR 데이터가 없어 자산가치 대비 가격 판단이 제한됩니다.");
  } else if (pbr <= sectorProfile.pbrGood) {
    score += 12;
    reasons.push("PBR이 업종 기준상 낮은 편입니다.");
  } else if (pbr <= sectorProfile.pbrOkay) {
    score += 5;
    reasons.push("PBR이 업종 기준상 무난한 수준입니다.");
  } else if (pbr <= sectorProfile.pbrHigh) {
    score -= 5;
    reasons.push("PBR이 다소 높은 편입니다.");
  } else {
    score -= 15;
    reasons.push("PBR이 높아 자산가치 대비 가격 부담이 있습니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function makeScoring(calculated, marketData, financials, sectorProfile) {
  const profitability = scoreProfitability(calculated, sectorProfile);
  const stability = scoreStability(calculated, sectorProfile);
  const growth = scoreGrowth(financials);
  const valuation = scoreValuation(marketData, sectorProfile);

  const total = Math.round(
    profitability.score * 0.3 +
    stability.score * 0.25 +
    growth.score * 0.25 +
    valuation.score * 0.2
  );

  let grade = "C";
  let riskLevel = "주의";
  let summary = "지표상 추가 확인이 필요한 종목입니다.";

  if (total >= 85) {
    grade = "A";
    riskLevel = "양호";
    summary = "현재 지표만 보면 재무·수익성·성장성 균형이 양호합니다.";
  } else if (total >= 70) {
    grade = "B";
    riskLevel = "보통";
    summary = "전반적으로 무난하지만 일부 지표는 추가 확인이 필요합니다.";
  } else if (total >= 55) {
    grade = "C";
    riskLevel = "주의";
    summary = "투자 전 리스크 요인을 더 확인해야 합니다.";
  } else {
    grade = "D";
    riskLevel = "고위험";
    summary = "현재 지표상 위험 신호가 많아 보수적 접근이 필요합니다.";
  }

  return {
    total,
    grade,
    riskLevel,
    summary,
    sector: {
      key: sectorProfile.key,
      label: sectorProfile.label
    },
    categories: {
      profitability: {
        label: "수익성",
        score: profitability.score
      },
      stability: {
        label: "안정성",
        score: stability.score
      },
      growth: {
        label: "성장성",
        score: growth.score
      },
      valuation: {
        label: "밸류에이션",
        score: valuation.score
      }
    },
    reasons: {
      profitability: profitability.reasons,
      stability: stability.reasons,
      growth: growth.reasons,
      valuation: valuation.reasons
    },
    comments: [
      ...profitability.reasons,
      ...stability.reasons,
      ...growth.reasons,
      ...valuation.reasons
    ]
  };
}

function makeChecklist(riskSignals, scoring, marketData, disclosures) {
  const items = [];

  items.push({
    title: "사업보고서에서 매출과 영업이익 감소 원인 확인",
    reason: "숫자만으로는 일시적 사이클인지 구조적 부진인지 알 수 없습니다.",
    priority: "높음"
  });

  items.push({
    title: "업종 평균 PER/PBR과 비교",
    reason: "PER과 PBR은 업종별 적정 수준이 크게 다릅니다.",
    priority: "높음"
  });

  if (riskSignals.some((risk) => risk.level === "high")) {
    items.push({
      title: "고위험 신호 원문 확인",
      reason: "고위험 신호는 단순 점수보다 우선 확인해야 합니다.",
      priority: "최상"
    });
  }

  if (marketData && marketData.raw && marketData.raw.per !== null && marketData.raw.per > 35) {
    items.push({
      title: "고PER을 정당화할 성장 근거 확인",
      reason: "높은 PER은 미래 성장 기대가 꺾일 때 큰 하락으로 이어질 수 있습니다.",
      priority: "높음"
    });
  }

  const hasRiskyDisclosure = (disclosures || []).some(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  );

  if (hasRiskyDisclosure) {
    items.push({
      title: "최근 주요 공시 원문 확인",
      reason: "유상증자, 전환사채, 최대주주 변경 등은 주가와 주주가치에 영향을 줄 수 있습니다.",
      priority: "최상"
    });
  }

  if (scoring.total < 55) {
    items.push({
      title: "매수 전 투자 비중 축소 또는 관망 검토",
      reason: "종합 점수가 낮은 종목은 리스크 요인을 먼저 해소해야 합니다.",
      priority: "높음"
    });
  }

  items.push({
    title: "다음 실적 발표 일정 확인",
    reason: "실적 발표 전후로 주가 변동성이 커질 수 있습니다.",
    priority: "보통"
  });

  items.push({
    title: "동종업계 경쟁사와 수익성 비교",
    reason: "개별 종목만 보면 비싸거나 싼지 판단하기 어렵습니다.",
    priority: "보통"
  });

  return items.slice(0, 8);
}

function makeInvestorViews(scoring, marketData) {
  const views = [];

  views.push({
    type: "안정형",
    verdict: scoring.categories.stability.score >= 70 ? "상대적으로 적합" : "주의 필요",
    comment:
      scoring.categories.stability.score >= 70
        ? "부채비율과 재무 안정성 점수가 양호합니다. 다만 실적 변동성은 추가 확인하세요."
        : "안정성 점수가 충분히 높지 않습니다. 부채, 적자, 현금흐름을 더 확인해야 합니다."
  });

  views.push({
    type: "성장형",
    verdict: scoring.categories.growth.score >= 70 ? "관심 가능" : "성장성 확인 필요",
    comment:
      scoring.categories.growth.score >= 70
        ? "최근 매출 또는 영업이익 성장 흐름이 긍정적으로 잡힙니다."
        : "최근 성장성이 강하게 확인되지는 않습니다. 업황과 다음 실적 전망을 확인하세요."
  });

  views.push({
    type: "가치형",
    verdict: scoring.categories.valuation.score >= 70 ? "저평가 후보" : "가격 부담 확인",
    comment:
      scoring.categories.valuation.score >= 70
        ? "PER/PBR 기준으로는 가격 부담이 낮아 보입니다. 단, 이익 감소형 저평가인지 구분해야 합니다."
        : "밸류에이션 매력이 크지 않거나 데이터가 부족합니다. 업종 평균과 비교하세요."
  });

  const dividendYield = marketData?.raw?.dividendYield;

  views.push({
    type: "배당형",
    verdict: dividendYield && dividendYield > 0.03 ? "검토 가능" : "배당 매력 제한",
    comment:
      dividendYield && dividendYield > 0.03
        ? "배당수익률은 눈에 띄지만, 배당성향과 현금흐름으로 지속 가능성을 확인해야 합니다."
        : "배당수익률 기준으로는 강한 매력이 확인되지 않습니다."
  });

  return views;
}

function makeDiagnosis(scoring, riskSignals, disclosures) {
  const diagnosis = [];

  diagnosis.push(`종합 진단 점수는 ${scoring.total}점이며, 위험도는 '${scoring.riskLevel}'입니다.`);
  diagnosis.push(scoring.summary);
  diagnosis.push(`업종 기준은 '${scoring.sector.label}' 기준으로 적용했습니다.`);

  const highRiskCount = riskSignals.filter((risk) => risk.level === "high").length;
  const mediumRiskCount = riskSignals.filter((risk) => risk.level === "medium").length;

  if (highRiskCount > 0) {
    diagnosis.push(`고위험 신호가 ${highRiskCount}개 감지되었습니다. 점수보다 위험 신호 원문 확인이 우선입니다.`);
  } else if (mediumRiskCount > 0) {
    diagnosis.push(`주의 신호가 ${mediumRiskCount}개 있습니다. 매수 전 원인 확인이 필요합니다.`);
  } else {
    diagnosis.push("현재 자동 탐지 기준에서는 강한 위험 신호가 많지 않습니다.");
  }

  const disclosureRiskCount = (disclosures || []).filter(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  ).length;

  if (disclosureRiskCount > 0) {
    diagnosis.push(`최근 공시 중 주의가 필요한 공시가 ${disclosureRiskCount}건 있습니다.`);
  }

  diagnosis.push("이 진단은 투자 추천이 아니라 매수 전 점검 도구입니다. 실제 투자 전 공시 원문과 증권사 데이터를 재확인해야 합니다.");

  return diagnosis;
}

function getPeerCodes(sectorKey, stockCode) {
  const peersBySector = {
    semiconductor: ["005930", "000660", "042700", "000990", "058470"],
    platform: ["035420", "035720", "259960", "036570"],
    finance: ["055550", "105560", "086790", "316140"],
    bio: ["068270", "207940", "128940", "196170"],
    construction: ["000720", "047040", "294870", "006360"],
    retail: ["139480", "023530", "004170", "282330"],
    general: ["005930", "000660", "035420", "051910"]
  };

  return (peersBySector[sectorKey] || peersBySector.general)
    .filter((code) => code !== stockCode)
    .slice(0, 3);
}

async function makePeerComparison(corpList, company, sectorProfile, currentMetrics, marketData) {
  const peers = [
    {
      name: company.corpName,
      code: company.stockCode,
      currentPrice: marketData ? marketData.display.currentPrice : "-",
      marketCap: marketData ? marketData.display.marketCap : "-",
      per: marketData ? marketData.display.per : "-",
      pbr: marketData ? marketData.display.pbr : "-",
      roe: currentMetrics.roe,
      debtRatio: currentMetrics.debtRatio,
      operatingMargin: currentMetrics.operatingMargin
    }
  ];

  const peerCodes = getPeerCodes(sectorProfile.key, company.stockCode);

  for (const code of peerCodes) {
    const peerCompany = corpList.find((corp) => corp.stockCode === code);
    if (!peerCompany) continue;

    let peerMarket = null;
    let peerRoe = "-";
    let peerDebtRatio = "-";
    let peerOperatingMargin = "-";

    try {
      peerMarket = await fetchMarketData(code);
    } catch (error) {
      console.log("경쟁사 시세 조회 실패:", code, error.message);
    }

    try {
      const statements = await fetchRecentFinancialStatements(peerCompany.corpCode, 1);
      if (statements.length > 0) {
        const extracted = extractMetrics(statements[0].rows);
        peerRoe = extracted.metrics.roe;
        peerDebtRatio = extracted.metrics.debtRatio;
        peerOperatingMargin = extracted.metrics.operatingMargin;
      }
    } catch (error) {
      console.log("경쟁사 재무 조회 실패:", code, error.message);
    }

    peers.push({
      name: peerCompany.corpName,
      code: peerCompany.stockCode,
      currentPrice: peerMarket ? peerMarket.display.currentPrice : "-",
      marketCap: peerMarket ? peerMarket.display.marketCap : "-",
      per: peerMarket ? peerMarket.display.per : "-",
      pbr: peerMarket ? peerMarket.display.pbr : "-",
      roe: peerRoe,
      debtRatio: peerDebtRatio,
      operatingMargin: peerOperatingMargin
    });
  }

  return peers;
}

function makeFallbackStockResponse(query, reason) {
  return {
    ok: true,
    source: "Fallback test data",
    warning: reason || "실제 데이터 조회에 실패하여 테스트 데이터를 표시합니다.",
    dataBasis: {
      year: "테스트",
      reportName: "테스트 데이터",
      fsDiv: "테스트"
    },
    company: {
      name: String(query).toUpperCase() === "TSLA" ? "Tesla" : "삼성전자",
      code: String(query).toUpperCase() === "TSLA" ? "TSLA" : "005930",
      corpCode: "-",
      market: String(query).toUpperCase() === "TSLA" ? "NASDAQ" : "KRX",
      sector: "테스트 데이터"
    },
    metrics: {
      currentPrice: "-",
      marketCap: "-",
      per: "-",
      pbr: "-",
      roe: "4.1%",
      debtRatio: "26.4%",
      operatingMargin: "6.9%",
      netMargin: "5.2%",
      dividendYield: "-"
    },
    scoring: {
      total: 50,
      grade: "C",
      riskLevel: "주의",
      summary: "실제 데이터 조회에 실패하여 임시 점수로 표시합니다.",
      sector: {
        key: "fallback",
        label: "테스트"
      },
      categories: {
        profitability: { label: "수익성", score: 50 },
        stability: { label: "안정성", score: 50 },
        growth: { label: "성장성", score: 50 },
        valuation: { label: "밸류에이션", score: 50 }
      },
      reasons: {
        profitability: ["실제 데이터 조회 실패"],
        stability: ["실제 데이터 조회 실패"],
        growth: ["실제 데이터 조회 실패"],
        valuation: ["실제 데이터 조회 실패"]
      },
      comments: [reason || "데이터 조회 실패"]
    },
    diagnosis: [
      "서버는 정상 응답했지만 실제 데이터 조회에 실패했습니다.",
      reason || "Render 환경변수, OpenDART 인증키, 외부 API 연결 상태를 확인해야 합니다.",
      "이 화면은 서버 연결 유지용 임시 테스트 데이터입니다."
    ],
    riskSignals: [
      {
        level: "medium",
        title: "실제 데이터 조회 실패",
        description: reason || "API 연결 상태를 확인해야 합니다."
      }
    ],
    checklist: [
      {
        title: "Render 환경변수 확인",
        reason: "OpenDART 인증키가 없으면 실제 재무제표 조회가 불가능합니다.",
        priority: "최상"
      }
    ],
    investorViews: [],
    disclosures: [],
    peerComparison: [],
    financials: [
      {
        year: "2023",
        fsDiv: "연결",
        revenue: "258.9조",
        operatingProfit: "6.6조",
        netProfit: "15.5조",
        rawRevenue: 258900000000000,
        rawOperatingProfit: 6600000000000,
        rawNetProfit: 15500000000000
      },
      {
        year: "2022",
        fsDiv: "연결",
        revenue: "302.2조",
        operatingProfit: "43.4조",
        netProfit: "55.7조",
        rawRevenue: 302200000000000,
        rawOperatingProfit: 43400000000000,
        rawNetProfit: 55700000000000
      },
      {
        year: "2021",
        fsDiv: "연결",
        revenue: "279.6조",
        operatingProfit: "51.6조",
        netProfit: "39.9조",
        rawRevenue: 279600000000000,
        rawOperatingProfit: 51600000000000,
        rawNetProfit: 39900000000000
      }
    ]
  };
}

app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    message: "server is running",
    opendartKey: hasOpenDartKey() ? "connected" : "missing",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/search", async function (req, res) {
  try {
    const query = req.query.query || "";
    const limit = Number(req.query.limit || 10);

    if (!hasOpenDartKey()) {
      return res.json({
        ok: true,
        results: []
      });
    }

    const corpList = await loadCorpList();
    const results = searchCompanies(corpList, query, limit);

    return res.json({
      ok: true,
      results
    });
  } catch (error) {
    console.error("SEARCH ERROR:", error.message);

    return res.json({
      ok: false,
      message: error.message,
      results: []
    });
  }
});

app.get("/api/market", async function (req, res) {
  try {
    const query = req.query.query;

    if (!query) {
      return res.status(400).json({
        ok: false,
        message: "검색어가 없습니다. 예: /api/market?query=005930"
      });
    }

    const marketData = await fetchMarketData(query);

    if (!marketData) {
      return res.status(200).json({
        ok: false,
        message: "시세 데이터를 찾지 못했습니다. 종목코드 또는 티커를 확인해주세요.",
        query
      });
    }

    return res.json({
      ok: true,
      source: "Yahoo Finance direct quote endpoint",
      ...marketData
    });
  } catch (error) {
    console.error(error);

    return res.status(200).json({
      ok: false,
      message: error.message || "시세 조회 중 서버 오류가 발생했습니다."
    });
  }
});

app.get("/api/stock", async function (req, res) {
  const query = req.query.query;

  if (!query) {
    return res.status(400).json({
      ok: false,
      message: "검색어가 없습니다. 예: /api/stock?query=005930"
    });
  }

  try {
    let marketData = null;

    try {
      marketData = await fetchMarketData(query);
    } catch (error) {
      console.log("시세 데이터 조회 실패:", error.message);
    }

    if (!hasOpenDartKey()) {
      return res.json(
        makeFallbackStockResponse(
          query,
          "OPENDART_API_KEY가 Render 환경변수에 없습니다. Render의 Environment에서 인증키를 추가해야 실제 재무제표가 표시됩니다."
        )
      );
    }

    const corpList = await loadCorpList();
    const company = findCompany(corpList, query);

    if (!company) {
      if (marketData) {
        const sectorProfile = getSectorProfile(marketData.symbol);
        const valuationScore = scoreValuation(marketData, sectorProfile);

        const scoring = {
          total: 50,
          grade: "C",
          riskLevel: "주의",
          summary: "해외주식 또는 OpenDART 미지원 종목입니다. 시세 기반 지표만 표시합니다.",
          sector: {
            key: sectorProfile.key,
            label: sectorProfile.label
          },
          categories: {
            profitability: { label: "수익성", score: 50 },
            stability: { label: "안정성", score: 50 },
            growth: { label: "성장성", score: 50 },
            valuation: {
              label: "밸류에이션",
              score: valuationScore.score
            }
          },
          reasons: {
            profitability: ["OpenDART 재무제표 분석이 불가능하여 중립으로 계산했습니다."],
            stability: ["OpenDART 재무제표 분석이 불가능하여 중립으로 계산했습니다."],
            growth: ["OpenDART 재무제표 분석이 불가능하여 중립으로 계산했습니다."],
            valuation: valuationScore.reasons
          },
          comments: [
            "OpenDART 재무제표 분석이 불가능하여 일부 점수는 중립으로 계산했습니다.",
            ...valuationScore.reasons
          ]
        };

        return res.json({
          ok: true,
          source: "Yahoo Finance direct quote endpoint",
          dataBasis: {
            year: "-",
            reportName: "해외 또는 OpenDART 미지원 종목",
            fsDiv: "-"
          },
          company: {
            name: marketData.symbol,
            code: marketData.symbol,
            corpCode: "-",
            market: marketData.currency || "-",
            sector: sectorProfile.label
          },
          metrics: {
            currentPrice: marketData.display.currentPrice,
            marketCap: marketData.display.marketCap,
            per: marketData.display.per,
            pbr: marketData.display.pbr,
            roe: "-",
            debtRatio: "-",
            operatingMargin: "-",
            netMargin: "-",
            dividendYield: marketData.display.dividendYield
          },
          scoring,
          diagnosis: [
            `종합 진단 점수는 ${scoring.total}점이며, 위험도는 '${scoring.riskLevel}'입니다.`,
            "이 종목은 OpenDART 재무제표 조회 대상이 아니거나 종목명/종목코드 매칭에 실패했습니다.",
            "현재가, 시가총액, PER, PBR 등 시세 기반 지표만 표시합니다.",
            "해외주식의 재무제표까지 분석하려면 SEC 또는 별도 해외주식 데이터 API 연결이 필요합니다."
          ],
          riskSignals: [
            {
              level: "medium",
              title: "재무제표 분석 제한",
              description: "OpenDART 대상 종목이 아니므로 재무제표 기반 분석이 제한됩니다."
            }
          ],
          checklist: [
            {
              title: "해외주식 재무제표 데이터 소스 연결",
              reason: "SEC 또는 별도 해외주식 API가 필요합니다.",
              priority: "높음"
            }
          ],
          investorViews: [],
          disclosures: [],
          peerComparison: [],
          financials: []
        });
      }

      return res.json(
        makeFallbackStockResponse(
          query,
          "OpenDART에서 해당 종목을 찾지 못했습니다. 종목명 또는 6자리 종목코드를 다시 확인해야 합니다."
        )
      );
    }

    if (!marketData) {
      try {
        marketData = await fetchMarketData(company.stockCode);
      } catch (error) {
        console.log("종목코드 기반 시세 데이터 조회 실패:", error.message);
      }
    }

    const statements = await fetchRecentFinancialStatements(company.corpCode, 5);

    if (!statements || statements.length === 0) {
      return res.json(
        makeFallbackStockResponse(
          query,
          "최근 사업보고서 재무제표 데이터를 찾지 못했습니다."
        )
      );
    }

    const latestStatement = statements[0];
    const latestExtracted = extractMetrics(latestStatement.rows);
    const financials = makeFinancialsFromStatements(statements);
    const sectorProfile = getSectorProfile(company.corpName);

    const disclosures = await fetchDisclosures(company.corpCode, 180);

    const scoring = makeScoring(
      latestExtracted.calculated,
      marketData,
      financials,
      sectorProfile
    );

    const riskSignals = detectRiskSignals(
      latestExtracted.calculated,
      marketData,
      financials,
      disclosures
    );

    const checklist = makeChecklist(riskSignals, scoring, marketData, disclosures);
    const investorViews = makeInvestorViews(scoring, marketData);
    const diagnosis = makeDiagnosis(scoring, riskSignals, disclosures);

    const peerComparison = await makePeerComparison(
      corpList,
      company,
      sectorProfile,
      latestExtracted.metrics,
      marketData
    );

    return res.json({
      ok: true,
      source: marketData
        ? "OpenDART + Yahoo Finance direct quote endpoint"
        : "OpenDART",
      dataBasis: {
        year: latestStatement.year,
        reportName: "사업보고서",
        fsDiv: latestStatement.fsDiv === "CFS" ? "연결재무제표" : "별도재무제표"
      },
      company: {
        name: company.corpName,
        code: company.stockCode,
        corpCode: company.corpCode,
        market: "KRX",
        sector: sectorProfile.label
      },
      metrics: {
        currentPrice: marketData ? marketData.display.currentPrice : "-",
        marketCap: marketData ? marketData.display.marketCap : "-",
        per: marketData ? marketData.display.per : "-",
        pbr: marketData ? marketData.display.pbr : "-",
        roe: latestExtracted.metrics.roe,
        debtRatio: latestExtracted.metrics.debtRatio,
        operatingMargin: latestExtracted.metrics.operatingMargin,
        netMargin: latestExtracted.metrics.netMargin,
        dividendYield: marketData ? marketData.display.dividendYield : "-"
      },
      scoring,
      diagnosis,
      riskSignals,
      checklist,
      investorViews,
      disclosures,
      peerComparison,
      financials
    });
  } catch (error) {
    console.error("API STOCK ERROR:", error);

    return res.json(
      makeFallbackStockResponse(
        query,
        error.message || "서버 내부 오류가 발생했습니다."
      )
    );
  }
});

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});
