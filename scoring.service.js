const axios = require("axios");
const { toNumber } = require("../utils/number");
const { formatNumber, formatMarketMoney } = require("../utils/format");

const marketCache = new Map();

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

module.exports = {
  fetchMarketData
};
