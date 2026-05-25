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

const REPORT_CODE = {
  ANNUAL: "11011"
};

function hasOpenDartKey() {
  return Boolean(OPENDART_API_KEY && OPENDART_API_KEY.trim() !== "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

async function fetchRecentFinancialStatements(corpCode, targetCount = 3) {
  const currentYear = new Date().getFullYear();

  const candidateYears = [
    currentYear - 1,
    currentYear - 2,
    currentYear - 3,
    currentYear - 4,
    currentYear - 5,
    currentYear - 6,
    currentYear - 7
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
      rawRevenue: extracted.raw.revenue,
      rawOperatingProfit: extracted.raw.operatingProfit,
      rawNetProfit: extracted.raw.netProfit
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

      return {
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
    } catch (error) {
      console.log("Yahoo Finance 직접 조회 실패:", symbol, error.message);
    }
  }

  return null;
}

function scoreProfitability(calculated) {
  let score = 50;
  const comments = [];

  if (calculated.roe === null) {
    comments.push("ROE 데이터가 없어 수익성 점수는 보수적으로 계산했습니다.");
  } else if (calculated.roe >= 15) {
    score += 25;
    comments.push("ROE가 15% 이상으로 자본 효율성이 우수합니다.");
  } else if (calculated.roe >= 10) {
    score += 18;
    comments.push("ROE가 10% 이상으로 자본 효율성이 양호합니다.");
  } else if (calculated.roe >= 5) {
    score += 5;
    comments.push("ROE가 보통 수준입니다.");
  } else if (calculated.roe >= 0) {
    score -= 15;
    comments.push("ROE가 낮아 수익성 점수가 낮아졌습니다.");
  } else {
    score -= 30;
    comments.push("ROE가 마이너스로 수익성 위험이 큽니다.");
  }

  if (calculated.operatingMargin === null) {
    comments.push("영업이익률 데이터가 없어 본업 수익성 판단이 제한됩니다.");
  } else if (calculated.operatingMargin >= 20) {
    score += 20;
    comments.push("영업이익률이 20% 이상으로 본업 수익성이 강합니다.");
  } else if (calculated.operatingMargin >= 10) {
    score += 12;
    comments.push("영업이익률이 10% 이상으로 양호합니다.");
  } else if (calculated.operatingMargin >= 5) {
    score += 3;
    comments.push("영업이익률은 보통 수준입니다.");
  } else if (calculated.operatingMargin >= 0) {
    score -= 12;
    comments.push("영업이익률이 낮아 가격 경쟁 또는 비용 부담 확인이 필요합니다.");
  } else {
    score -= 25;
    comments.push("영업손실 상태로 본업 수익성 위험이 큽니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    comments
  };
}

function scoreStability(calculated) {
  let score = 60;
  const comments = [];

  if (calculated.debtRatio === null) {
    score -= 5;
    comments.push("부채비율 데이터가 없어 안정성 판단이 제한됩니다.");
  } else if (calculated.debtRatio <= 50) {
    score += 25;
    comments.push("부채비율이 50% 이하로 재무 안정성이 우수합니다.");
  } else if (calculated.debtRatio <= 100) {
    score += 15;
    comments.push("부채비율이 100% 이하로 안정적인 편입니다.");
  } else if (calculated.debtRatio <= 150) {
    score += 3;
    comments.push("부채비율은 중간 수준입니다.");
  } else if (calculated.debtRatio <= 250) {
    score -= 15;
    comments.push("부채비율이 높아 차입 부담 확인이 필요합니다.");
  } else {
    score -= 30;
    comments.push("부채비율이 매우 높아 재무 안정성 위험이 큽니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    comments
  };
}

function scoreGrowth(financials) {
  let score = 50;
  const comments = [];

  if (!Array.isArray(financials) || financials.length < 2) {
    comments.push("비교 가능한 과거 재무 데이터가 부족해 성장성 점수는 중립으로 계산했습니다.");
    return {
      score,
      comments
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
    comments.push("매출 성장률 계산이 제한됩니다.");
  } else if (revenueGrowth >= 20) {
    score += 20;
    comments.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 5) {
    score += 10;
    comments.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 0) {
    score += 2;
    comments.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 15;
    comments.push(`최근 매출이 전년 대비 ${Math.abs(revenueGrowth).toFixed(1)}% 감소했습니다.`);
  }

  if (operatingProfitGrowth === null) {
    comments.push("영업이익 성장률 계산이 제한됩니다.");
  } else if (operatingProfitGrowth >= 30) {
    score += 25;
    comments.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 10) {
    score += 15;
    comments.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 0) {
    score += 3;
    comments.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 20;
    comments.push(`최근 영업이익이 전년 대비 ${Math.abs(operatingProfitGrowth).toFixed(1)}% 감소했습니다.`);
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
        comments.push("최근 3년 매출이 연속 증가했습니다.");
      } else if (first.rawRevenue < second.rawRevenue && second.rawRevenue < third.rawRevenue) {
        score -= 8;
        comments.push("최근 3년 매출이 연속 감소했습니다.");
      }
    }
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    comments
  };
}

function scoreValuation(marketData) {
  let score = 50;
  const comments = [];

  if (!marketData || !marketData.raw) {
    comments.push("시세 데이터가 없어 밸류에이션 점수는 중립으로 계산했습니다.");
    return {
      score,
      comments
    };
  }

  const per = marketData.raw.per;
  const pbr = marketData.raw.pbr;

  if (per === null || per <= 0) {
    comments.push("PER 데이터가 없거나 적자 구간이라 PER 판단이 제한됩니다.");
  } else if (per <= 10) {
    score += 18;
    comments.push("PER이 10배 이하로 가격 부담은 낮아 보입니다. 단, 이익 감소형 저PER인지 확인이 필요합니다.");
  } else if (per <= 20) {
    score += 10;
    comments.push("PER이 20배 이하로 과도하게 비싸다고 보기는 어렵습니다.");
  } else if (per <= 35) {
    score -= 5;
    comments.push("PER이 다소 높은 편입니다. 성장성이 이를 정당화하는지 확인해야 합니다.");
  } else {
    score -= 18;
    comments.push("PER이 높아 밸류에이션 부담이 큽니다.");
  }

  if (pbr === null || pbr <= 0) {
    comments.push("PBR 데이터가 없어 자산가치 대비 가격 판단이 제한됩니다.");
  } else if (pbr <= 1) {
    score += 12;
    comments.push("PBR이 1배 이하로 자산가치 대비 낮게 평가되어 있습니다.");
  } else if (pbr <= 2) {
    score += 5;
    comments.push("PBR이 2배 이하로 무난한 수준입니다.");
  } else if (pbr <= 4) {
    score -= 5;
    comments.push("PBR이 다소 높은 편입니다.");
  } else {
    score -= 15;
    comments.push("PBR이 높아 자산가치 대비 가격 부담이 있습니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    comments
  };
}

function makeScoring(calculated, marketData, financials) {
  const profitability = scoreProfitability(calculated);
  const stability = scoreStability(calculated);
  const growth = scoreGrowth(financials);
  const valuation = scoreValuation(marketData);

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
    comments: [
      ...profitability.comments,
      ...stability.comments,
      ...growth.comments,
      ...valuation.comments
    ]
  };
}

function makeDiagnosis(calculated, marketData, financials, scoring) {
  const diagnosis = [];

  diagnosis.push(`종합 진단 점수는 ${scoring.total}점이며, 위험도는 '${scoring.riskLevel}'입니다.`);
  diagnosis.push(scoring.summary);

  if (calculated.roe === null) {
    diagnosis.push("ROE 계산에 필요한 순이익 또는 자본 항목을 찾지 못했습니다.");
  } else if (calculated.roe >= 12) {
    diagnosis.push("ROE가 12% 이상으로 자본 효율성이 양호한 편입니다.");
  } else if (calculated.roe >= 5) {
    diagnosis.push("ROE는 보통 수준입니다. 업종 평균과 비교가 필요합니다.");
  } else if (calculated.roe >= 0) {
    diagnosis.push("ROE가 낮습니다. 이익 체력이 약하거나 자본 효율이 떨어질 수 있습니다.");
  } else {
    diagnosis.push("ROE가 마이너스입니다. 적자 또는 자본 훼손 가능성을 확인해야 합니다.");
  }

  if (calculated.debtRatio === null) {
    diagnosis.push("부채비율 계산에 필요한 부채 또는 자본 항목을 찾지 못했습니다.");
  } else if (calculated.debtRatio <= 80) {
    diagnosis.push("부채비율은 낮은 편으로 재무 안정성은 상대적으로 양호합니다.");
  } else if (calculated.debtRatio <= 150) {
    diagnosis.push("부채비율은 중간 수준입니다. 업종 특성을 함께 봐야 합니다.");
  } else {
    diagnosis.push("부채비율이 높습니다. 금리, 차입금, 이자비용 부담을 확인해야 합니다.");
  }

  if (marketData && marketData.display) {
    diagnosis.push(
      "현재가, 시가총액, PER, PBR은 Yahoo Finance 공개 데이터를 기반으로 조회한 테스트 데이터입니다. 실서비스에서는 공식 시세 API로 교체하는 것이 안전합니다."
    );
  } else {
    diagnosis.push(
      "현재가, 시가총액, PER, PBR을 가져오지 못했습니다. 시세 데이터 소스 확인이 필요합니다."
    );
  }

  return diagnosis;
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
      categories: {
        profitability: {
          label: "수익성",
          score: 50
        },
        stability: {
          label: "안정성",
          score: 50
        },
        growth: {
          label: "성장성",
          score: 50
        },
        valuation: {
          label: "밸류에이션",
          score: 50
        }
      },
      comments: [
        "실제 데이터 조회에 실패했습니다.",
        reason || "Render 환경변수, OpenDART 인증키, 외부 API 연결 상태를 확인해야 합니다."
      ]
    },
    diagnosis: [
      "서버는 정상 응답했지만 실제 데이터 조회에 실패했습니다.",
      reason || "Render 환경변수, OpenDART 인증키, 외부 API 연결 상태를 확인해야 합니다.",
      "이 화면은 서버 연결 유지용 임시 테스트 데이터입니다."
    ],
    financials: [
      {
        year: "2023",
        revenue: "258.9조",
        operatingProfit: "6.6조",
        netProfit: "15.5조"
      },
      {
        year: "2022",
        revenue: "302.2조",
        operatingProfit: "43.4조",
        netProfit: "55.7조"
      },
      {
        year: "2021",
        revenue: "279.6조",
        operatingProfit: "51.6조",
        netProfit: "39.9조"
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
        const scoring = {
          total: 50,
          grade: "C",
          riskLevel: "주의",
          summary: "해외주식 또는 OpenDART 미지원 종목입니다. 시세 기반 지표만 표시합니다.",
          categories: {
            profitability: {
              label: "수익성",
              score: 50
            },
            stability: {
              label: "안정성",
              score: 50
            },
            growth: {
              label: "성장성",
              score: 50
            },
            valuation: {
              label: "밸류에이션",
              score: scoreValuation(marketData).score
            }
          },
          comments: [
            "OpenDART 재무제표 분석이 불가능하여 재무 점수는 중립으로 계산했습니다.",
            ...scoreValuation(marketData).comments
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
            sector: "OpenDART 미지원"
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

    const statements = await fetchRecentFinancialStatements(company.corpCode, 3);

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
    const scoring = makeScoring(latestExtracted.calculated, marketData, financials);
    const diagnosis = makeDiagnosis(
      latestExtracted.calculated,
      marketData,
      financials,
      scoring
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
        sector: "OpenDART 추가 항목 필요"
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
