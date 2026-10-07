import assert from "node:assert/strict";
import { test } from "node:test";

import { JapaneseGenericCardParser } from "../src/parser/japanese-generic.js";
import { EmailParserRegistry } from "../src/parser/registry.js";
import type { EmailParser, ParserInput } from "../src/parser/types.js";

const parser = new JapaneseGenericCardParser();

function input(bodyText: string): ParserInput {
  return {
    sender: "notice@example-card.jp",
    subject: "カードご利用のお知らせ",
    bodyText
  };
}

test("parses Japanese transaction labels and preserves exact amount", () => {
  const result = parser.parse(input(`ご利用日：2026年10月5日
ご利用先：Amazon.co.jp
ご利用金額：3,500円`));

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;

  assert.deepEqual(result.transactions[0], {
    date: "2026-10-05",
    time: null,
    merchant: "Amazon.co.jp",
    amount: "3500",
    currency: "JPY",
    category: "other",
    cardName: null,
    parserKey: "japanese-generic"
  });
});

test("parses alternate labels, full-width text, date separators and optional time/card", () => {
  const result = parser.parse(input(`利用日
２０２６／１０／０５　９：０３
利用先
「コンビニ ＡＢＣ」
金額
￥１，２３０
ご利用カード：Visa ゴールド`));

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;

  assert.deepEqual(result.transactions[0], {
    date: "2026-10-05",
    time: "09:03",
    merchant: "コンビニ ABC",
    amount: "1230",
    currency: "JPY",
    category: "other",
    cardName: "Visa ゴールド",
    parserKey: "japanese-generic"
  });
});

test("extracts a timestamp and international currency when present", () => {
  const result = parser.parse(input(`ご利用日時：2026-10-05 14:03:09
加盟店名：Online store
利用金額：USD 12.50`));

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;

  assert.deepEqual(result.transactions[0], {
    date: "2026-10-05",
    time: "14:03:09",
    merchant: "Online store",
    amount: "12.50",
    currency: "USD",
    category: "other",
    cardName: null,
    parserKey: "japanese-generic"
  });
});

test("returns safe unsupported reasons for missing or invalid transaction fields", () => {
  assert.deepEqual(
    parser.parse(input("ご利用先：Amazon\nご利用金額：1,000円")),
    { status: "unsupported", reason: "missing_date" }
  );
  assert.deepEqual(
    parser.parse(input("ご利用日：2026年2月30日\nご利用先：Amazon\n金額：100円")),
    { status: "unsupported", reason: "invalid_date" }
  );
  assert.deepEqual(
    parser.parse(input("利用日：2026-10-05\n利用先：Amazon\n利用金額：確認中")),
    { status: "unsupported", reason: "invalid_amount" }
  );
});

test("rejects emails that have no complete card transaction fields", () => {
  const registry = new EmailParserRegistry([parser]);
  const result = registry.parse(input("お支払い方法に関するお知らせです。"));

  assert.deepEqual(result, {
    status: "unsupported",
    reason: "no_matching_parser"
  });
});

test("registry prefers an earlier provider-specific parser", () => {
  const providerParser: EmailParser = {
    key: "provider-example",
    canParse: () => true,
    parse: () => ({ status: "parsed", transactions: [], parserKey: "provider-example" })
  };
  const registry = new EmailParserRegistry([providerParser, parser]);

  assert.deepEqual(
    registry.parse(input("unstructured provider message")),
    { status: "parsed", transactions: [], parserKey: "provider-example" }
  );
});

test("parser does not include unrelated email text in failures", () => {
  const privateBody = "secret-account-reference-12345";
  const result = parser.parse(input(privateBody));

  assert.equal(result.status, "unsupported");
  assert.equal(JSON.stringify(result).includes(privateBody), false);
});
