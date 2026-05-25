const { clamp, growthRate } = require("../utils/number");

function detectRiskSignals(calculated, marketData, financials, disclosures) {
  const risks = [];

  if (calculated.roe !== null && calculated.roe < 5) {
    risks.push({
      level: "medium",
      title: "ROE 낮음",
      description: "자본 대비 이익 창출력이 약합니다. 일시적 부진인지 구조적 저수익인지 확인해야 합니다."
    });
  }

  if (calculated.roe !== null && calculated.roe < 0) {
    risks.push({
      level: "high",
      title: "ROE 마이너스",
      description: "적자 또는 자본 훼손 가능성이 있습니다."
    });
  }

  if (calculated.operatingMargin !== null && calculated.operatingMargin < 3) {
    risks.push({
      level: "medium",
      title: "영업이익률 낮음",
      description: "본업 수익성이 약합니다. 가격 경쟁, 원가 상승, 고정비 부담을 확인해야 합니다."
    });
  }

  if (calculated.operatingMargin !== null && calculated.operatingMargin < 0) {
    risks.push({
      level: "high",
      title: "영업손실",
      description: "본업에서 손실이 발생하고 있습니다. 흑자 전환 가능성을 보수적으로 봐야 합니다."
    });
  }

  if (calculated.debtRatio !== null && calculated.debtRatio > 200) {
    risks.push({
      level: "high",
      title: "부채비율 높음",
      description: "금리, 차입금 만기, 이자비용 부담을 확인해야 합니다."
    });
  }

  if (Array.isArray(financials) && financials.length >= 2) {
    const latest = financials[0];
    const previous = financials[1];

    const revenueGrowth = growthRate(latest.rawRevenue, previous.rawRevenue);
    const operatingProfitGrowth = growthRate(
      latest.rawOperatingProfit,
      previous.rawOperatingProfit
    );

    if (revenueGrowth !== null && revenueGrowth < -10) {
      risks.push({
        level: "medium",
        title: "매출 감소",
        description: `최근 매출이 전년 대비 ${Math.abs(revenueGrowth).toFixed(1)}% 감소했습니다. 성장성 둔화 여부 확인이 필요합니다.`
      });
    }

    if (operatingProfitGrowth !== null && operatingProfitGrowth < -20) {
      risks.push({
        level: "high",
        title: "영업이익 급감",
        description: `최근 영업이익이 전년 대비 ${Math.abs(operatingProfitGrowth).toFixed(1)}% 감소했습니다. 일회성인지 구조적인지 확인해야 합니다.`
      });
    }

    if (
      Number.isFinite(latest.rawNetProfit) &&
      Number.isFinite(previous.rawNetProfit) &&
      latest.rawNetProfit < 0 &&
      previous.rawNetProfit > 0
    ) {
      risks.push({
        level: "high",
        title: "순이익 적자 전환",
        description: "순이익이 흑자에서 적자로 전환되었습니다. 비용, 손상차손, 영업외손익을 확인해야 합니다."
      });
    }
  }

  if (marketData && marketData.raw) {
    if (marketData.raw.per !== null && marketData.raw.per > 40) {
      risks.push({
        level: "medium",
        title: "PER 높음",
        description: "현재 이익 대비 가격 부담이 큽니다. 성장성이 이를 정당화하는지 확인해야 합니다."
      });
    }

    if (marketData.raw.pbr !== null && marketData.raw.pbr > 5) {
      risks.push({
        level: "medium",
        title: "PBR 높음",
        description: "자산가치 대비 가격 부담이 있습니다. 고ROE가 유지되는지 확인해야 합니다."
      });
    }
  }

  const riskyDisclosures = (disclosures || []).filter(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  );

  riskyDisclosures.slice(0, 3).forEach((item) => {
    risks.push({
      level: item.riskLevel,
      title: `주의 공시: ${item.riskLabel}`,
      description: `${item.reportName} - ${item.comment}`
    });
  });

  if (risks.length === 0) {
    risks.push({
      level: "low",
      title: "즉시 확인되는 주요 위험 신호 적음",
      description: "현재 지표상 강한 위험 신호는 많지 않습니다. 다만 업종 리스크와 최신 공시는 별도로 확인해야 합니다."
    });
  }

  return risks;
}

function scoreProfitability(calculated, sectorProfile) {
  let score = 50;
  const reasons = [];

  if (calculated.roe === null) {
    reasons.push("ROE 데이터가 없어 수익성 점수는 보수적으로 계산했습니다.");
  } else if (calculated.roe >= sectorProfile.roeGood) {
    score += 25;
    reasons.push(`ROE가 ${sectorProfile.roeGood}% 이상으로 업종 기준상 양호합니다.`);
  } else if (calculated.roe >= sectorProfile.roeOkay) {
    score += 10;
    reasons.push("ROE가 업종 기준상 보통 수준입니다.");
  } else if (calculated.roe >= 0) {
    score -= 15;
    reasons.push("ROE가 낮아 자본 효율성이 약합니다.");
  } else {
    score -= 35;
    reasons.push("ROE가 마이너스입니다.");
  }

  if (sectorProfile.marginGood === 0) {
    reasons.push("금융업 등 일부 업종은 영업이익률 비교 의미가 낮아 ROE 중심으로 판단했습니다.");
  } else if (calculated.operatingMargin === null) {
    score -= 3;
    reasons.push("영업이익률 데이터가 없어 본업 수익성 판단이 제한됩니다.");
  } else if (calculated.operatingMargin >= sectorProfile.marginGood) {
    score += 20;
    reasons.push("영업이익률이 업종 기준상 우수합니다.");
  } else if (calculated.operatingMargin >= sectorProfile.marginOkay) {
    score += 8;
    reasons.push("영업이익률이 업종 기준상 보통 수준입니다.");
  } else if (calculated.operatingMargin >= 0) {
    score -= 12;
    reasons.push("영업이익률이 낮아 본업 수익성이 약합니다.");
  } else {
    score -= 25;
    reasons.push("영업손실 상태입니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreStability(calculated, sectorProfile) {
  let score = 60;
  const reasons = [];

  if (calculated.debtRatio === null) {
    score -= 5;
    reasons.push("부채비율 데이터가 없어 안정성 판단이 제한됩니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtGood) {
    score += 25;
    reasons.push("부채비율이 업종 기준상 안정적입니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtOkay) {
    score += 10;
    reasons.push("부채비율이 업종 기준상 보통 수준입니다.");
  } else if (calculated.debtRatio <= sectorProfile.debtWarn) {
    score -= 10;
    reasons.push("부채비율이 높아 차입 부담 확인이 필요합니다.");
  } else {
    score -= 30;
    reasons.push("부채비율이 매우 높습니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreGrowth(financials) {
  let score = 50;
  const reasons = [];

  if (!Array.isArray(financials) || financials.length < 2) {
    reasons.push("비교 가능한 과거 재무 데이터가 부족해 성장성 점수는 중립으로 계산했습니다.");
    return {
      score,
      reasons
    };
  }

  const latest = financials[0];
  const previous = financials[1];

  const revenueGrowth = growthRate(latest.rawRevenue, previous.rawRevenue);
  const operatingProfitGrowth = growthRate(
    latest.rawOperatingProfit,
    previous.rawOperatingProfit
  );

  if (revenueGrowth === null) {
    reasons.push("매출 성장률 계산이 제한됩니다.");
  } else if (revenueGrowth >= 20) {
    score += 20;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 5) {
    score += 10;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (revenueGrowth >= 0) {
    score += 2;
    reasons.push(`최근 매출이 전년 대비 ${revenueGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 15;
    reasons.push(`최근 매출이 전년 대비 ${Math.abs(revenueGrowth).toFixed(1)}% 감소했습니다.`);
  }

  if (operatingProfitGrowth === null) {
    reasons.push("영업이익 성장률 계산이 제한됩니다.");
  } else if (operatingProfitGrowth >= 30) {
    score += 25;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 10) {
    score += 15;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else if (operatingProfitGrowth >= 0) {
    score += 3;
    reasons.push(`최근 영업이익이 전년 대비 ${operatingProfitGrowth.toFixed(1)}% 증가했습니다.`);
  } else {
    score -= 20;
    reasons.push(`최근 영업이익이 전년 대비 ${Math.abs(operatingProfitGrowth).toFixed(1)}% 감소했습니다.`);
  }

  if (financials.length >= 3) {
    const first = financials[0];
    const second = financials[1];
    const third = financials[2];

    if (
      Number.isFinite(first.rawRevenue) &&
      Number.isFinite(second.rawRevenue) &&
      Number.isFinite(third.rawRevenue)
    ) {
      if (first.rawRevenue > second.rawRevenue && second.rawRevenue > third.rawRevenue) {
        score += 8;
        reasons.push("최근 3년 매출이 연속 증가했습니다.");
      } else if (first.rawRevenue < second.rawRevenue && second.rawRevenue < third.rawRevenue) {
        score -= 8;
        reasons.push("최근 3년 매출이 연속 감소했습니다.");
      }
    }
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function scoreValuation(marketData, sectorProfile) {
  let score = 50;
  const reasons = [];

  if (!marketData || !marketData.raw) {
    reasons.push("시세 데이터가 없어 밸류에이션 점수는 중립으로 계산했습니다.");
    return {
      score,
      reasons
    };
  }

  const per = marketData.raw.per;
  const pbr = marketData.raw.pbr;

  if (per === null || per <= 0) {
    reasons.push("PER 데이터가 없거나 적자 구간이라 PER 판단이 제한됩니다.");
  } else if (per <= sectorProfile.perGood) {
    score += 18;
    reasons.push("PER이 업종 기준상 낮은 편입니다. 단, 이익 감소형 저PER인지 확인해야 합니다.");
  } else if (per <= sectorProfile.perOkay) {
    score += 8;
    reasons.push("PER이 업종 기준상 무난한 수준입니다.");
  } else if (per <= sectorProfile.perHigh) {
    score -= 5;
    reasons.push("PER이 다소 높은 편입니다.");
  } else {
    score -= 20;
    reasons.push("PER이 높아 밸류에이션 부담이 큽니다.");
  }

  if (pbr === null || pbr <= 0) {
    reasons.push("PBR 데이터가 없어 자산가치 대비 가격 판단이 제한됩니다.");
  } else if (pbr <= sectorProfile.pbrGood) {
    score += 12;
    reasons.push("PBR이 업종 기준상 낮은 편입니다.");
  } else if (pbr <= sectorProfile.pbrOkay) {
    score += 5;
    reasons.push("PBR이 업종 기준상 무난한 수준입니다.");
  } else if (pbr <= sectorProfile.pbrHigh) {
    score -= 5;
    reasons.push("PBR이 다소 높은 편입니다.");
  } else {
    score -= 15;
    reasons.push("PBR이 높아 자산가치 대비 가격 부담이 있습니다.");
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons
  };
}

function makeScoring(calculated, marketData, financials, sectorProfile) {
  const profitability = scoreProfitability(calculated, sectorProfile);
  const stability = scoreStability(calculated, sectorProfile);
  const growth = scoreGrowth(financials);
  const valuation = scoreValuation(marketData, sectorProfile);

  const total = Math.round(
    profitability.score * 0.3 +
    stability.score * 0.25 +
    growth.score * 0.25 +
    valuation.score * 0.2
  );

  let grade = "C";
  let riskLevel = "주의";
  let summary = "지표상 추가 확인이 필요한 종목입니다.";

  if (total >= 85) {
    grade = "A";
    riskLevel = "양호";
    summary = "현재 지표만 보면 재무·수익성·성장성 균형이 양호합니다.";
  } else if (total >= 70) {
    grade = "B";
    riskLevel = "보통";
    summary = "전반적으로 무난하지만 일부 지표는 추가 확인이 필요합니다.";
  } else if (total >= 55) {
    grade = "C";
    riskLevel = "주의";
    summary = "투자 전 리스크 요인을 더 확인해야 합니다.";
  } else {
    grade = "D";
    riskLevel = "고위험";
    summary = "현재 지표상 위험 신호가 많아 보수적 접근이 필요합니다.";
  }

  return {
    total,
    grade,
    riskLevel,
    summary,
    sector: {
      key: sectorProfile.key,
      label: sectorProfile.label
    },
    categories: {
      profitability: {
        label: "수익성",
        score: profitability.score
      },
      stability: {
        label: "안정성",
        score: stability.score
      },
      growth: {
        label: "성장성",
        score: growth.score
      },
      valuation: {
        label: "밸류에이션",
        score: valuation.score
      }
    },
    reasons: {
      profitability: profitability.reasons,
      stability: stability.reasons,
      growth: growth.reasons,
      valuation: valuation.reasons
    },
    comments: [
      ...profitability.reasons,
      ...stability.reasons,
      ...growth.reasons,
      ...valuation.reasons
    ]
  };
}

function makeChecklist(riskSignals, scoring, marketData, disclosures) {
  const items = [];

  items.push({
    title: "사업보고서에서 매출과 영업이익 감소 원인 확인",
    reason: "숫자만으로는 일시적 사이클인지 구조적 부진인지 알 수 없습니다.",
    priority: "높음"
  });

  items.push({
    title: "업종 평균 PER/PBR과 비교",
    reason: "PER과 PBR은 업종별 적정 수준이 크게 다릅니다.",
    priority: "높음"
  });

  if (riskSignals.some((risk) => risk.level === "high")) {
    items.push({
      title: "고위험 신호 원문 확인",
      reason: "고위험 신호는 단순 점수보다 우선 확인해야 합니다.",
      priority: "최상"
    });
  }

  if (marketData && marketData.raw && marketData.raw.per !== null && marketData.raw.per > 35) {
    items.push({
      title: "고PER을 정당화할 성장 근거 확인",
      reason: "높은 PER은 미래 성장 기대가 꺾일 때 큰 하락으로 이어질 수 있습니다.",
      priority: "높음"
    });
  }

  const hasRiskyDisclosure = (disclosures || []).some(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  );

  if (hasRiskyDisclosure) {
    items.push({
      title: "최근 주요 공시 원문 확인",
      reason: "유상증자, 전환사채, 최대주주 변경 등은 주가와 주주가치에 영향을 줄 수 있습니다.",
      priority: "최상"
    });
  }

  if (scoring.total < 55) {
    items.push({
      title: "매수 전 투자 비중 축소 또는 관망 검토",
      reason: "종합 점수가 낮은 종목은 리스크 요인을 먼저 해소해야 합니다.",
      priority: "높음"
    });
  }

  items.push({
    title: "다음 실적 발표 일정 확인",
    reason: "실적 발표 전후로 주가 변동성이 커질 수 있습니다.",
    priority: "보통"
  });

  items.push({
    title: "동종업계 경쟁사와 수익성 비교",
    reason: "개별 종목만 보면 비싸거나 싼지 판단하기 어렵습니다.",
    priority: "보통"
  });

  return items.slice(0, 8);
}

function makeInvestorViews(scoring, marketData) {
  const views = [];

  views.push({
    type: "안정형",
    verdict: scoring.categories.stability.score >= 70 ? "상대적으로 적합" : "주의 필요",
    comment:
      scoring.categories.stability.score >= 70
        ? "부채비율과 재무 안정성 점수가 양호합니다. 다만 실적 변동성은 추가 확인하세요."
        : "안정성 점수가 충분히 높지 않습니다. 부채, 적자, 현금흐름을 더 확인해야 합니다."
  });

  views.push({
    type: "성장형",
    verdict: scoring.categories.growth.score >= 70 ? "관심 가능" : "성장성 확인 필요",
    comment:
      scoring.categories.growth.score >= 70
        ? "최근 매출 또는 영업이익 성장 흐름이 긍정적으로 잡힙니다."
        : "최근 성장성이 강하게 확인되지는 않습니다. 업황과 다음 실적 전망을 확인하세요."
  });

  views.push({
    type: "가치형",
    verdict: scoring.categories.valuation.score >= 70 ? "저평가 후보" : "가격 부담 확인",
    comment:
      scoring.categories.valuation.score >= 70
        ? "PER/PBR 기준으로는 가격 부담이 낮아 보입니다. 단, 이익 감소형 저평가인지 구분해야 합니다."
        : "밸류에이션 매력이 크지 않거나 데이터가 부족합니다. 업종 평균과 비교하세요."
  });

  const dividendYield = marketData?.raw?.dividendYield;

  views.push({
    type: "배당형",
    verdict: dividendYield && dividendYield > 0.03 ? "검토 가능" : "배당 매력 제한",
    comment:
      dividendYield && dividendYield > 0.03
        ? "배당수익률은 눈에 띄지만, 배당성향과 현금흐름으로 지속 가능성을 확인해야 합니다."
        : "배당수익률 기준으로는 강한 매력이 확인되지 않습니다."
  });

  return views;
}

function makeDiagnosis(scoring, riskSignals, disclosures) {
  const diagnosis = [];

  diagnosis.push(`종합 진단 점수는 ${scoring.total}점이며, 위험도는 '${scoring.riskLevel}'입니다.`);
  diagnosis.push(scoring.summary);
  diagnosis.push(`업종 기준은 '${scoring.sector.label}' 기준으로 적용했습니다.`);

  const highRiskCount = riskSignals.filter((risk) => risk.level === "high").length;
  const mediumRiskCount = riskSignals.filter((risk) => risk.level === "medium").length;

  if (highRiskCount > 0) {
    diagnosis.push(`고위험 신호가 ${highRiskCount}개 감지되었습니다. 점수보다 위험 신호 원문 확인이 우선입니다.`);
  } else if (mediumRiskCount > 0) {
    diagnosis.push(`주의 신호가 ${mediumRiskCount}개 있습니다. 매수 전 원인 확인이 필요합니다.`);
  } else {
    diagnosis.push("현재 자동 탐지 기준에서는 강한 위험 신호가 많지 않습니다.");
  }

  const disclosureRiskCount = (disclosures || []).filter(
    (item) => item.riskLevel === "high" || item.riskLevel === "medium"
  ).length;

  if (disclosureRiskCount > 0) {
    diagnosis.push(`최근 공시 중 주의가 필요한 공시가 ${disclosureRiskCount}건 있습니다.`);
  }

  diagnosis.push("이 진단은 투자 추천이 아니라 매수 전 점검 도구입니다. 실제 투자 전 공시 원문과 증권사 데이터를 재확인해야 합니다.");

  return diagnosis;
}

module.exports = {
  detectRiskSignals,
  scoreValuation,
  makeScoring,
  makeChecklist,
  makeInvestorViews,
  makeDiagnosis
};
