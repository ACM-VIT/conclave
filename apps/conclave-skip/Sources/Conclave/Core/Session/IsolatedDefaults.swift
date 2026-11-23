import Foundation

enum IsolatedDefaults {
    static func make() -> UserDefaults {
        #if SKIP
        return UserDefaults(suiteName: "conclave.isolated")!
        #else
        return MemoryDefaults()
        #endif
    }
}

#if !SKIP
final class MemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]

    init() {
        super.init(suiteName: nil)!
    }

    override func object(forKey defaultName: String) -> Any? {
        lock.withLock { values[defaultName] }
    }

    override func set(_ value: Any?, forKey defaultName: String) {
        lock.withLock { values[defaultName] = value }
    }

    override func removeObject(forKey defaultName: String) {
        lock.withLock { _ = values.removeValue(forKey: defaultName) }
    }
}
#endif
