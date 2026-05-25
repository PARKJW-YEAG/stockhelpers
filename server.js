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

  const text = String(value)
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/-/g, "");

  if (!text) return null;

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function formatWon(value) {
  if (value === null || value === undefined) return "-";

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
        return {
          year,
          fsDiv,
          rows: data.list
        };
      }
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
      per: "시세 API 필요",
      pbr: "시세 API 필요",
      roe: formatPercent(roeRaw === null ? null : roeRaw * 100),
      debtRatio: formatPercent(debtRatioRaw === null ? null : debtRatioRaw * 100),
      operatingMargin: formatPercent(operatingMarginRaw === null ? null : operatingMarginRaw * 100),
      netMargin: formatPercent(netMarginRaw === null ? null : netMarginRaw * 100),
      dividendYield: "시세 API 필요"
    },
    calculated: {
      roe: roeRaw === null ? null : roeRaw * 100,
      debtRatio: debtRatioRaw === null ? null : debtRatioRaw * 100,
      operatingMargin: operatingMarginRaw === null ? null : operatingMarginRaw * 100,
      netMargin: netMarginRaw === null ? null : netMarginRaw * 100
    }
  };
}

function makeDiagnosis(calculated) {
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

  diagnosis.push("현재 PER, PBR, 배당수익률은 OpenDART만으로 계산하기 어렵습니다. 다음 단계에서 시세 API를 연결해야 합니다.");

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

app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    message: "server is running",
    opendartKey: OPENDART_API_KEY ? "connected" : "missing"
  });
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

    const corpList = await loadCorpList();
    const company = findCompany(corpList, query);

    if (!company) {
      return res.status(404).json({
        ok: false,
        message: "해당 종목을 찾지 못했습니다. 종목명 또는 6자리 종목코드를 다시 확인해주세요."
      });
    }

    const statement = await fetchFinancialStatement(company.corpCode);

    if (!statement) {
      return res.status(404).json({
        ok: false,
        message: "최근 5년 내 사업보고서 재무제표 데이터를 찾지 못했습니다."
      });
    }

    const extracted = extractMetrics(statement.rows);
    const diagnosis = makeDiagnosis(extracted.calculated);

    return res.json({
      ok: true,
      source: "OpenDART",
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
      metrics: extracted.metrics,
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
