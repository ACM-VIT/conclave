import Foundation

@MainActor
final class MemoryPressure {
    static let shared = MemoryPressure()

    private var handlers: [String: () -> Void] = [:]
    private(set) var signalCount = 0

    var subscriberIds: [String] { handlers.keys.sorted() }

    func subscribe(_ id: String, _ handler: @escaping () -> Void) {
        handlers[id] = handler
    }

    func unsubscribe(_ id: String) {
        handlers.removeValue(forKey: id)
    }

    func signal() {
        signalCount += 1
        for id in handlers.keys.sorted() {
            handlers[id]?()
        }
    }
}

enum MemoryPressureHooks {
    static let chatImages = "chat.images"

    @MainActor
    static func install() {
        MemoryPressure.shared.subscribe(chatImages) { releaseChatImages() }
    }

    @MainActor
    static func releaseChatImages() {
        #if SKIP
        ChatImageMemory.clear()
        #elseif os(iOS)
        ChatImageLoader.cache.removeAllObjects()
        #endif
    }
}
