import XCTest
@testable import MoneyLens

final class MoneyLensTests: XCTestCase {
    func testMainNavigationIncludesAllPrimarySections() {
        XCTAssertEqual(
            AppTab.allCases.map(\.rawValue),
            ["Dashboard", "Transactions", "Charts", "Settings"]
        )
    }

    func testMoneyValueDecodesExactDecimalStringFromAPI() throws {
        let data = Data("\"3500.000000\"".utf8)
        let amount = try JSONDecoder().decode(MoneyValue.self, from: data)

        XCTAssertEqual(amount.value, Decimal(3500))
    }

    func testMoneyValueDecodesNumericJSONAmount() throws {
        let data = Data("12.50".utf8)
        let amount = try JSONDecoder().decode(MoneyValue.self, from: data)

        XCTAssertEqual(amount.value, Decimal(string: "12.5"))
    }
}
