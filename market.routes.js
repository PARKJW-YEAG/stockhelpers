const express = require("express");
const { hasOpenDartKey } = require("../services/opendart.service");

const router = express.Router();

router.get("/", function (req, res) {
  res.json({
    ok: true,
    message: "server is running",
    opendartKey: hasOpenDartKey() ? "connected" : "missing",
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
