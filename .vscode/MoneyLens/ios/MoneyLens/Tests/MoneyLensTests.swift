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

    func testCategoriesResponseDecodesItemsEnvelope() throws {
        let data = Data(
            """
            {
              "items": [
                {
                  "id": "25d3f269-48fa-4a1a-8f77-e0cf1aa3286b",
                  "slug": "shopping",
                  "name": "Shopping",
                  "isDefault": true
                }
              ]
            }
            """.utf8
        )
        let result = try JSONDecoder().decode(TransactionCategoriesResponse.self, from: data)

        XCTAssertEqual(result.items.count, 1)
        XCTAssertEqual(result.items[0].name, "Shopping")
        XCTAssertTrue(result.items[0].isDefault)
    }

    func testCategoryUpdateEncodesNullToClearCategory() throws {
        let data = try JSONEncoder().encode(CategoryUpdateRequest(categoryId: nil))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: NSNull]
        )

        XCTAssertNotNil(object["categoryId"])
    }

    func testSpendingChartsDecodeDecimalStringsAndCategoryTotals() throws {
        let data = Data(
            """
            {
              "period": "daily",
              "from": "2026-10-01",
              "to": "2026-10-07",
              "series": [
                {"date": "2026-10-05", "currency": "JPY", "amount": "3500"}
              ],
              "categories": [
                {
                  "categoryId": "25d3f269-48fa-4a1a-8f77-e0cf1aa3286b",
                  "category": "Shopping",
                  "currency": "JPY",
                  "amount": "3500"
                }
              ]
            }
            """.utf8
        )
        let result = try JSONDecoder().decode(SpendingCharts.self, from: data)

        XCTAssertEqual(result.series.first?.amount.value, Decimal(3500))
        XCTAssertEqual(result.categories.first?.category, "Shopping")
    }

    func testDeleteTransactionsResponseDecodesDeletedCount() throws {
        let data = Data("{\"deletedCount\":3}".utf8)
        let result = try JSONDecoder().decode(DeleteTransactionsResponse.self, from: data)

        XCTAssertEqual(result.deletedCount, 3)
    }

    func testAppleSignInNonceResponseDecodesOneTimeChallenge() throws {
        let data = Data(
            """
            {
              "nonce": "Bap4t7NRTXY7iGqa-DiPR5HP9d3n0sXoNlywE3PH7GI",
              "expiresIn": 300
            }
            """.utf8
        )
        let result = try JSONDecoder().decode(AppleSignInNonce.self, from: data)

        XCTAssertEqual(result.expiresIn, 300)
        XCTAssertEqual(result.nonce.count, 43)
    }

    func testAccountDeletionDecodesGoogleRevocationStatus() throws {
        let data = Data(
            "{\"deleted\":true,\"googleRevocation\":\"revoked\"}".utf8
        )
        let result = try JSONDecoder().decode(AccountDeletionResponse.self, from: data)

        XCTAssertTrue(result.deleted)
        XCTAssertEqual(result.googleRevocation, "revoked")
    }

    func testAppSessionResponseDecodesBearerToken() throws {
        let data = Data(
            """
            {
              "accessToken": "Bap4t7NRTXY7iGqa-DiPR5HP9d3n0sXoNlywE3PH7GI",
              "tokenType": "Bearer",
              "expiresIn": 604800
            }
            """.utf8
        )
        let result = try JSONDecoder().decode(AppSessionResponse.self, from: data)

        XCTAssertEqual(result.tokenType, "Bearer")
        XCTAssertEqual(result.expiresIn, 604800)
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
