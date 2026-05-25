const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { parseStringPromise } = require("xml2js");
const yahooFinance = require("yahoo-finance2").default;
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

function checkApiKey() {
  if (!OPENDART_API_KEY) {
    throw new Error("OPENDART_API_KEY가 Render 환경변수에 없습니다.");
  }
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
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";

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
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
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
  checkApiKey();

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

async function fetchFinancialStatement(corpCode) {
  checkApiKey();

  const currentYear = new Date().getFullYear();
  const years = [
    currentYear - 1,
    currentYear - 2,
    currentYear - 3,
    currentYear - 4,
    currentYear - 5
  ];

  for (const year of years) {
    for (const fsDiv of ["CFS", "OFS"]) {
      const cacheKey = `${corpCode}:${year}:${fsDiv}`;

      if (financeCache.has(cacheKey)) {
        const cached = financeCache.get(cacheKey);
        if (cached) return cached;
        continue;
      }

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

      if (data.status === "000" && Array.isArray(data.list) && data.list.length > 0) {
        const result = {
          year,
          fsDiv,
          rows: data.list
        };

        financeCache.set(cacheKey, result);
        return result;
      }

      financeCache.set(cacheKey, null);
    }
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

function makeDiagnosis(calculated, marketData) {
  const diagnosis = [];

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

  if (calculated.operatingMargin === null) {
    diagnosis.push("영업이익률 계산에 필요한 매출 또는 영업이익 항목을 찾지 못했습니다.");
  } else if (calculated.operatingMargin >= 15) {
    diagnosis.push("영업이익률이 15% 이상으로 본업 수익성이 좋은 편입니다.");
  } else if (calculated.operatingMargin >= 5) {
    diagnosis.push("영업이익률은 보통 수준입니다. 최근 3년 추세 확인이 필요합니다.");
  } else if (calculated.operatingMargin >= 0) {
    diagnosis.push("영업이익률이 낮습니다. 가격 경쟁이나 비용 부담이 있는지 확인해야 합니다.");
  } else {
    diagnosis.push("영업손실 상태입니다. 흑자 전환 가능성을 보수적으로 봐야 합니다.");
  }

  if (marketData && marketData.display) {
    diagnosis.push(
      "현재가, 시가총액, PER, PBR은 Yahoo Finance 기반 테스트 데이터입니다. 실서비스에서는 공식 시세 API로 교체하는 것이 안전합니다."
    );
  } else {
    diagnosis.push(
      "현재가, 시가총액, PER, PBR을 가져오지 못했습니다. 시세 데이터 소스 확인이 필요합니다."
    );
  }

  return diagnosis;
}

function makeFinancials(year, raw) {
  return [
    {
      year: String(year),
      revenue: formatWon(raw.revenue),
      operatingProfit: formatWon(raw.operatingProfit),
      netProfit: formatWon(raw.netProfit)
    }
  ];
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
      const result = await yahooFinance.quoteSummary(symbol, {
        modules: ["price", "summaryDetail", "defaultKeyStatistics"]
      });

      const price = result.price || {};
      const summaryDetail = result.summaryDetail || {};
      const defaultKeyStatistics = result.defaultKeyStatistics || {};

      const currentPrice = toNumber(price.regularMarketPrice);
      const currency = price.currency || null;
      const marketCap = toNumber(price.marketCap) || toNumber(summaryDetail.marketCap);
      const per = toNumber(summaryDetail.trailingPE) || toNumber(defaultKeyStatistics.trailingPE);
      const pbr = toNumber(defaultKeyStatistics.priceToBook);
      const dividendYieldRaw = toNumber(summaryDetail.dividendYield);

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
            dividendYieldRaw === null ? "-" : (dividendYieldRaw * 100).toFixed(2) + "%"
        }
      };
    } catch (error) {
      console.log("Yahoo Finance 조회 실패:", symbol, error.message);
    }
  }

  return null;
}

app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    message: "server is running",
    opendartKey: OPENDART_API_KEY ? "connected" : "missing"
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
      return res.status(404).json({
        ok: false,
        message: "시세 데이터를 찾지 못했습니다. 종목코드 또는 티커를 확인해주세요."
      });
    }

    return res.json({
      ok: true,
      source: "Yahoo Finance via yahoo-finance2",
      ...marketData
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: error.message || "시세 조회 중 서버 오류가 발생했습니다."
    });
  }
});

app.get("/api/stock", async function (req, res) {
  try {
    const query = req.query.query;

    if (!query) {
      return res.status(400).json({
        ok: false,
        message: "검색어가 없습니다. 예: /api/stock?query=005930"
      });
    }

    let marketData = null;

    try {
      marketData = await fetchMarketData(query);
    } catch (error) {
      console.log("시세 데이터 조회 실패:", error.message);
    }

    const corpList = await loadCorpList();
    const company = findCompany(corpList, query);

    if (!company) {
      if (marketData) {
        return res.json({
          ok: true,
          source: "Yahoo Finance",
          dataBasis: {
            year: "-",
            reportName: "해외 또는 비상장 OpenDART 미지원 종목",
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
          diagnosis: [
            "이 종목은 OpenDART 재무제표 조회 대상이 아니거나, 종목명/종목코드 매칭에 실패했습니다.",
            "현재가, 시가총액, PER, PBR 등 시세 기반 지표만 표시합니다.",
            "해외주식의 재무제표까지 분석하려면 SEC 또는 별도 해외주식 데이터 API 연결이 필요합니다."
          ],
          financials: []
        });
      }

      return res.status(404).json({
        ok: false,
        message: "해당 종목을 찾지 못했습니다. 종목명 또는 6자리 종목코드를 다시 확인해주세요."
      });
    }

    if (!marketData) {
      try {
        marketData = await fetchMarketData(company.stockCode);
      } catch (error) {
        console.log("종목코드 기반 시세 데이터 조회 실패:", error.message);
      }
    }

    const statement = await fetchFinancialStatement(company.corpCode);

    if (!statement) {
      return res.status(404).json({
        ok: false,
        message: "최근 5년 내 사업보고서 재무제표 데이터를 찾지 못했습니다."
      });
    }

    const extracted = extractMetrics(statement.rows);
    const diagnosis = makeDiagnosis(extracted.calculated, marketData);

    return res.json({
      ok: true,
      source: marketData
        ? "OpenDART + Yahoo Finance via yahoo-finance2"
        : "OpenDART",
      dataBasis: {
        year: statement.year,
        reportName: "사업보고서",
        fsDiv: statement.fsDiv === "CFS" ? "연결재무제표" : "별도재무제표"
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
        roe: extracted.metrics.roe,
        debtRatio: extracted.metrics.debtRatio,
        operatingMargin: extracted.metrics.operatingMargin,
        netMargin: extracted.metrics.netMargin,
        dividendYield: marketData ? marketData.display.dividendYield : "-"
      },
      diagnosis,
      financials: makeFinancials(statement.year, extracted.raw)
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: error.message || "서버 오류가 발생했습니다."
    });
  }
});

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});
