import Foundation

#if SKIP
func debugLog(_ message: String) { }
func debugLog(_ message: () -> String) { }
#elseif DEBUG
private let debugLoggingEnabled: Bool = {
    let value = ProcessInfo.processInfo.environment["CONCLAVE_DEBUG_LOGS"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    return ["1", "true", "yes", "on"].contains(value ?? "")
}()

func debugLog(_ message: @autoclosure () -> String) {
    guard debugLoggingEnabled else { return }
    Swift.print(message())
}

func debugLog(_ message: () -> String) {
    guard debugLoggingEnabled else { return }
    Swift.print(message())
}
#else
func debugLog(_ message: @autoclosure () -> String) { }
func debugLog(_ message: () -> String) { }
#endif
