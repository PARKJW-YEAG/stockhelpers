const express = require("express");
const {
  hasOpenDartKey,
  loadCorpList,
  searchCompanies
} = require("../services/opendart.service");

const router = express.Router();

router.get("/", async function (req, res) {
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

module.exports = router;
