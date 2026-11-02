import Foundation

@MainActor
final class ChatDraftStore {

    static let writeDelayMillis = 500.0
    private var drafts: [String: String] = [:]

    init() {}

    func text(for key: String) -> String {
        drafts[key] ?? ""
    }

    func setText(_ text: String, for key: String) {
        if text.isEmpty {
            drafts.removeValue(forKey: key)
        } else {
            drafts[key] = text
        }
    }

    var count: Int { drafts.count }

    func reset() {
        drafts = [:]
    }
}
