const { fetchMarketData } = require("./market.service");
const {
  fetchRecentFinancialStatements,
  extractMetrics
} = require("./opendart.service");

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

module.exports = {
  makePeerComparison
};
