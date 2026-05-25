const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// public 폴더 안의 index.html을 사이트 화면으로 보여줌
app.use(express.static(path.join(__dirname, "public")));

// 서버 상태 확인용 API
app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    message: "server is running"
  });
});

// 주식 검색 테스트 API
app.get("/api/stock", function (req, res) {
  const query = req.query.query;

  if (!query) {
    res.status(400).json({
      ok: false,
      message: "검색어가 없습니다. 예: /api/stock?query=005930"
    });
    return;
  }

  res.json({
    ok: true,
    query: query,
    company: {
      name: "삼성전자",
      code: "005930",
      market: "KOSPI",
      sector: "반도체 / 전자"
    },
    metrics: {
      per: "예시",
      pbr: "예시",
      roe: "4.1%",
      debtRatio: "26.4%",
      operatingMargin: "6.9%",
      netMargin: "5.2%",
      dividendYield: "예시"
    },
    diagnosis: [
      "이 데이터는 아직 테스트용 예시 데이터입니다.",
      "Render 배포가 성공하면 다음 단계에서 OpenDART 실제 데이터를 연결합니다.",
      "현재 목표는 클라우드 서버 배포 성공입니다."
    ],
    financials: [
      {
        year: "2021",
        revenue: "279.6조",
        operatingProfit: "51.6조",
        netProfit: "39.9조"
      },
      {
        year: "2022",
        revenue: "302.2조",
        operatingProfit: "43.4조",
        netProfit: "55.7조"
      },
      {
        year: "2023",
        revenue: "258.9조",
        operatingProfit: "6.6조",
        netProfit: "15.5조"
      }
    ]
  });
});

// 그 외 주소로 들어오면 index.html 보여주기
app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});