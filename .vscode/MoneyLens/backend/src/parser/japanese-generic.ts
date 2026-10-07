import type {
  EmailParser,
  ParseFailureReason,
  ParseResult,
  ParsedTransaction,
  ParserInput
} from "./types.js";

const dateLabels = ["ご利用日時", "ご利用日", "利用日", "ご利用年月日", "利用年月日"];
const merchantLabels = ["ご利用先", "利用先", "ご利用店舗", "利用店舗", "加盟店名", "ご利用店"];
const amountLabels = ["ご利用金額", "利用金額", "ご利用額", "利用額", "金額"];
const cardLabels = ["ご利用カード", "利用カード", "カード名", "カード名称", "カード"];

const recognizedLabels = [
  ...dateLabels,
  ...merchantLabels,
  ...amountLabels,
  ...cardLabels
].sort((left, right) => right.length - left.length);

const labelPattern = new RegExp(
  `^\\s*(${recognizedLabels.map(escapeRegExp).join("|")})\\s*(?:[:：=＝]\\s*)?(.*?)\\s*$`
);

export class JapaneseGenericCardParser implements EmailParser {
  readonly key = "japanese-generic";

  canParse(input: ParserInput): boolean {
    const text = normalizeText(input.bodyText);
    return dateLabels.some((label) => hasLabel(text, label))
      && merchantLabels.some((label) => hasLabel(text, label))
      && amountLabels.some((label) => hasLabel(text, label));
  }

  parse(input: ParserInput): ParseResult {
    const fields = readFields(input.bodyText);
    const dateValue = firstField(fields, dateLabels);
    if (!dateValue) {
      return unsupported("missing_date");
    }

    const parsedDate = parseJapaneseDate(dateValue);
    if (parsedDate === null) {
      return unsupported("invalid_date");
    }

    const merchantValue = firstField(fields, merchantLabels);
    if (!merchantValue) {
      return unsupported("missing_merchant");
    }

    const amountValue = firstField(fields, amountLabels);
    if (!amountValue) {
      return unsupported("missing_amount");
    }

    const parsedAmount = parseAmount(amountValue);
    if (parsedAmount === null) {
      return unsupported("invalid_amount");
    }

    const transaction: ParsedTransaction = {
      date: parsedDate.date,
      time: parsedDate.time,
      merchant: normalizeMerchant(merchantValue),
      amount: parsedAmount.amount,
      currency: parsedAmount.currency,
      category: "other",
      cardName: firstField(fields, cardLabels) ?? null,
      parserKey: this.key
    };

    if (!transaction.merchant) {
      return unsupported("missing_merchant");
    }

    return { status: "parsed", transactions: [transaction], parserKey: this.key };
  }
}

function unsupported(reason: ParseFailureReason): ParseResult {
  return { status: "unsupported", reason };
}

function readFields(bodyText: string): Map<string, string> {
  const lines = normalizeText(bodyText)
    .replace(/<[^>]*>/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const fields = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const match = line.match(labelPattern);
    if (!match) {
      continue;
    }

    const label = match[1];
    if (!label) {
      continue;
    }
    const inlineValue = match[2]?.trim() ?? "";
    if (fields.has(label)) {
      continue;
    }

    if (inlineValue) {
      fields.set(label, inlineValue);
      continue;
    }

    const followingValue = lines.slice(index + 1).find((candidate) => (
      candidate.length > 0 && !labelPattern.test(candidate)
    ));
    if (followingValue) {
      fields.set(label, followingValue);
    }
  }

  return fields;
}

function firstField(fields: Map<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    const value = fields.get(label);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseJapaneseDate(value: string): { date: string; time: string | null } | null {
  const normalized = normalizeText(value);
  const match = normalized.match(
    /(\d{4})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?/
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year)
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  const timeMatch = normalized.match(/(?:^|\s)([01]?\d|2[0-3])\s*:\s*([0-5]\d)(?:\s*:\s*([0-5]\d))?/);
  const time = timeMatch
    ? `${timeMatch[1]!.padStart(2, "0")}:${timeMatch[2]}${timeMatch[3] ? `:${timeMatch[3]}` : ""}`
    : null;

  return {
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time
  };
}

function parseAmount(value: string): { amount: string; currency: string } | null {
  const normalized = normalizeText(value).replace(/[,\s]/g, "");
  const match = normalized.match(/([+-]?\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed === 0) {
    return null;
  }

  const amount = match[1]!;
  const currency = /US\$|USD|\$/.test(normalized)
    ? "USD"
    : /€|EUR/.test(normalized)
      ? "EUR"
      : /£|GBP/.test(normalized)
        ? "GBP"
        : "JPY";

  return { amount, currency };
}

function normalizeMerchant(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[「『"'“”]+|[」』"'“”]+$/g, "")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function hasLabel(text: string, label: string): boolean {
  const pattern = new RegExp(`^\\s*${escapeRegExp(label)}\\s*(?:[:：=＝]|$)`, "m");
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
