const express = require("express");
const { fetchMarketData } = require("../services/market.service");

const router = express.Router();

router.get("/", async function (req, res) {
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

module.exports = router;
