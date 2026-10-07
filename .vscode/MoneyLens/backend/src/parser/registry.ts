import { JapaneseGenericCardParser } from "./japanese-generic.js";
import type { EmailParser, ParseResult, ParserInput } from "./types.js";

export class EmailParserRegistry {
  constructor(private readonly parsers: readonly EmailParser[]) {}

  parse(input: ParserInput): ParseResult {
    const parser = this.parsers.find((candidate) => candidate.canParse(input));
    if (!parser) {
      return { status: "unsupported", reason: "no_matching_parser" };
    }

    return parser.parse(input);
  }
}

export const defaultEmailParserRegistry = new EmailParserRegistry([
  new JapaneseGenericCardParser()
]);
