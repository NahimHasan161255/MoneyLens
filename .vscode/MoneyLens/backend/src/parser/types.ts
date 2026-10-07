export interface ParserInput {
  sender: string;
  subject: string;
  bodyText: string;
}

export interface ParsedTransaction {
  date: string;
  time: string | null;
  merchant: string;
  amount: string;
  currency: string;
  category: "other";
  cardName: string | null;
  parserKey: string;
}

export type ParseFailureReason =
  | "no_matching_parser"
  | "missing_date"
  | "invalid_date"
  | "missing_merchant"
  | "missing_amount"
  | "invalid_amount";

export type ParseResult =
  | { status: "parsed"; transactions: ParsedTransaction[]; parserKey: string }
  | { status: "unsupported"; reason: ParseFailureReason };

export interface EmailParser {
  readonly key: string;
  canParse(input: ParserInput): boolean;
  parse(input: ParserInput): ParseResult;
}
