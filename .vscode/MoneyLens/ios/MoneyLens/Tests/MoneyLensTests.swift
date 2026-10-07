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

    func testGmailSyncResponseDecodesServerCounts() throws {
        let data = Data(
            """
            {
              "runId": "25d3f269-48fa-4a1a-8f77-e0cf1aa3286b",
              "status": "completed",
              "addedCount": 2,
              "skippedCount": 1,
              "unsupportedCount": 1,
              "examinedCount": 4,
              "reconciled": false
            }
            """.utf8
        )
        let result = try JSONDecoder().decode(GmailSyncResponse.self, from: data)

        XCTAssertEqual(result.status, "completed")
        XCTAssertEqual(result.addedCount, 2)
        XCTAssertEqual(result.skippedCount, 1)
        XCTAssertEqual(result.unsupportedCount, 1)
        XCTAssertEqual(result.examinedCount, 4)
        XCTAssertFalse(result.reconciled)
    }
}
