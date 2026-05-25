function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanNumber(value) {
  if (value === undefined || value === null) return null;

  let text = String(value)
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .trim();

  if (!text || text === "-") return null;

  let isNegativeByParentheses = false;

  if (text.startsWith("(") && text.endsWith(")")) {
    isNegativeByParentheses = true;
    text = text.replace(/[()]/g, "");
  }

  const number = Number(text);

  if (!Number.isFinite(number)) return null;

  return isNegativeByParentheses ? -number : number;
}

function toNumber(value) {
  if (value === undefined || value === null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "object" && value.raw !== undefined) {
    return toNumber(value.raw);
  }

  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function divide(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return a / b;
}

function growthRate(latest, previous) {
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }

  return ((latest - previous) / Math.abs(previous)) * 100;
}

module.exports = {
  clamp,
  cleanNumber,
  toNumber,
  divide,
  growthRate
};
