import Foundation

enum AudioRouteRowLine: String, CaseIterable, Equatable {
    case none, connecting, allowAccess, allowAccessInSettings
}

struct AudioRouteRowModel: Equatable, Identifiable {
    let id: String
    let kind: AudioRouteKind

    let name: String

    let isSelected: Bool

    let isPending: Bool
    let line: AudioRouteRowLine

    let isAccessRow: Bool
}

enum RoutePickerPolicy {

    static let switchTimeoutMillis = AudioRouteChangePolicy.requestTimeoutMillis

    static func isAccessRow(_ id: String) -> Bool {
        id == AudioRouteOwner.bluetoothAccessOptionId
    }

    static func rows(_ route: AudioRouteSnapshot) -> [AudioRouteRowModel] {
        var result: [AudioRouteRowModel] = []
        for option in route.options {
            if isAccessRow(option.id) {
                let line = route.bluetoothAccess == BluetoothRouteAccess.needsSettings
                    ? AudioRouteRowLine.allowAccessInSettings : AudioRouteRowLine.allowAccess
                result.append(AudioRouteRowModel(id: option.id, kind: AudioRouteKind.bluetooth, name: option.name, isSelected: false,
                                                 isPending: false, line: line, isAccessRow: true))
                continue
            }
            let pending = route.phase == RouteSwitchPhase.switching && option.id == route.pendingId
            result.append(AudioRouteRowModel(id: option.id, kind: option.kind, name: option.name,
                                             isSelected: option.id == route.currentId && !pending, isPending: pending,
                                             line: option.isConnecting ? AudioRouteRowLine.connecting : AudioRouteRowLine.none,
                                             isAccessRow: false))
        }
        return result
    }

    static func dismissesAfter(requestedId: String, route: AudioRouteSnapshot) -> Bool {
        if requestedId.isEmpty || route.phase != RouteSwitchPhase.idle { return false }
        if isAccessRow(requestedId) {
            return route.bluetoothAccess == BluetoothRouteAccess.notNeeded && route.routeKind == AudioRouteKind.bluetooth
        }
        return route.currentId == requestedId
    }

    static func requestFailed(requestedId: String, route: AudioRouteSnapshot) -> Bool {
        !requestedId.isEmpty && route.phase == RouteSwitchPhase.failed && route.pendingId == requestedId
    }

    static func failureNotice(routeId: String) -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.routeFailed, severity: NoticeSeverity.error,
                           actions: [NoticeAction.make(NoticeAction.retry)], detail: routeId)
    }

    static func retryRouteId(_ notice: MeetingNotice) -> String {
        notice.kind == NoticeKind.routeFailed ? notice.detail : ""
    }
}
