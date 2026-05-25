const express = require("express");
const { getSectorProfile } = require("../data/sector-rules");
const {
  hasOpenDartKey,
  loadCorpList,
  findCompany,
  fetchRecentFinancialStatements,
  extractMetrics,
  makeFinancialsFromStatements
} = require("../services/opendart.service");
const { fetchMarketData } = require("../services/market.service");
const { fetchDisclosures } = require("../services/disclosure.service");
const { makePeerComparison } = require("../services/peer.service");
const { makeFallbackStockResponse } = require("../services/fallback.service");
const {
  scoreValuation,
  makeScoring,
  detectRiskSignals,
  makeChecklist,
  makeInvestorViews,
  makeDiagnosis
} = require("../services/scoring.service");

const router = express.Router();

router.get("/", async function (req, res) {
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

module.exports = router;
