const axios = require("axios");
const AdmZip = require("adm-zip");
const { parseStringPromise } = require("xml2js");
const { REPORT_CODE } = require("../data/report-codes");
const { cleanNumber, divide } = require("../utils/number");
const { formatWon, formatPercent } = require("../utils/format");

const OPENDART_API_KEY = process.env.OPENDART_API_KEY;

let corpListCache = null;
let corpListFetchedAt = 0;
const financeCache = new Map();

function hasOpenDartKey() {
  return Boolean(OPENDART_API_KEY && OPENDART_API_KEY.trim() !== "");
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

module.exports = {
  hasOpenDartKey,
  loadCorpList,
  findCompany,
  searchCompanies,
  fetchRecentFinancialStatements,
  extractMetrics,
  makeFinancialsFromStatements
};
