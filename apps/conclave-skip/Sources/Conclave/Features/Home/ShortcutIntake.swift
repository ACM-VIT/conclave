import Foundation

enum ConclaveShortcut: String, CaseIterable {
    case newMeeting = "new_meeting"
    case joinCode = "join_code"
    case rejoin = "rejoin"
    case recent = "recent"

    static let typePrefix = "com.acmvit.conclave."

    var platformType: String { ConclaveShortcut.typePrefix + rawValue }

    static func from(type: String) -> ConclaveShortcut? {
        let trimmed = type.trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = trimmed.hasPrefix(typePrefix) ? String(trimmed.dropFirst(typePrefix.count)) : trimmed
        return ConclaveShortcut(rawValue: bare)
    }
}

@MainActor
final class ShortcutIntake {
    static let shared = ShortcutIntake()

    private var presenter: PremeetingPresenter? = nil
    private var pendingType = ""
    private var pendingPayload = ""

    var hasPendingShortcut: Bool { !pendingType.isEmpty }

    func attach(_ presenter: PremeetingPresenter?) {
        self.presenter = presenter
        guard let presenter, let shortcut = ConclaveShortcut.from(type: pendingType) else { return }
        let payload = pendingPayload
        pendingType = ""
        pendingPayload = ""
        ShortcutIntake.deliver(shortcut, payload: payload, to: presenter)
    }

    @discardableResult
    func handle(type: String, payload: String) -> Bool {
        guard let shortcut = ConclaveShortcut.from(type: type) else { return false }
        if let presenter {
            ShortcutIntake.deliver(shortcut, payload: payload, to: presenter)
        } else {
            pendingType = shortcut.rawValue
            pendingPayload = payload
        }
        return true
    }

    static func deliver(_ shortcut: ConclaveShortcut, payload: String, to presenter: PremeetingPresenter) {
        let busy = presenter.isSessionBusy
        switch shortcut {
        case .newMeeting:
            guard !busy else { return }
            presenter.newMeeting()
        case .joinCode:
            let link = joinLink(payload)
            if !link.isEmpty {
                presenter.handleIncomingURL(link)
            } else if !busy {
                presenter.openJoinSheet()
            }
        case .rejoin:
            guard !busy else { return }
            presenter.rejoin()
        case .recent:
            if !busy {
                presenter.openRecent(id: payload)
            } else if let row = presenter.home.recents.first(where: { $0.id == payload }) {
                presenter.handleIncomingURL(row.roomId)
            }
        }
    }

    static func joinLink(_ payload: String) -> String {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.contains("/") ? trimmed : EntryPolicies.sanitizeRoomInput(trimmed)
    }
}
