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

module.exports = {
  makeFallbackStockResponse
};
