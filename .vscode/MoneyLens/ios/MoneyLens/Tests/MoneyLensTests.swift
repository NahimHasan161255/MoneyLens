import XCTest
@testable import MoneyLens

final class MoneyLensTests: XCTestCase {
    func testMainNavigationIncludesAllPrimarySections() {
        XCTAssertEqual(
            AppTab.allCases.map(\.rawValue),
            ["Dashboard", "Transactions", "Charts", "Settings"]
        )
    }
}
