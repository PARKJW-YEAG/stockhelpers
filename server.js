const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const healthRoutes = require("./src/routes/health.routes");
const searchRoutes = require("./src/routes/search.routes");
const stockRoutes = require("./src/routes/stock.routes");
const marketRoutes = require("./src/routes/market.routes");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/health", healthRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/market", marketRoutes);

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});
