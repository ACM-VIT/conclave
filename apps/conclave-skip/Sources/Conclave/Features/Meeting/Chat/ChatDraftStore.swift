import Foundation

/// S40 R40-7: chat drafts survive closing and reopening the panel and a sheet to inspector migration, keyed by room and
/// recipient (`ChatComposerPolicy.draftKey`). A plain class, never observed: the composer writes after 500 ms idle
/// and on disappear, never per keystroke, and reads once when it appears. Dropped with the session (`reset()`).
@MainActor
final class ChatDraftStore {
    /// The idle delay before a draft is written (6 k).
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
