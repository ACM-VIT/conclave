import Foundation
#if os(macOS) || os(Linux) // Skip transpiled tests only run on supported hosts
import SkipTest

@available(macOS 13, macCatalyst 16, *)
final class XCSkipTests: XCTestCase, XCGradleHarness {
    public func testSkipModule() async throws {
        guard ProcessInfo.processInfo.environment["CONCLAVE_RUN_SKIP_GRADLE_TESTS"] == "1" else { return }

        try await runGradleTests()
    }
}
#endif

let isJava = ProcessInfo.processInfo.environment["java.io.tmpdir"] != nil
let isAndroid = isJava && ProcessInfo.processInfo.environment["ANDROID_ROOT"] != nil
let isRobolectric = isJava && !isAndroid
let is32BitInteger = Int64(Int.max) == Int64(Int32.max)
