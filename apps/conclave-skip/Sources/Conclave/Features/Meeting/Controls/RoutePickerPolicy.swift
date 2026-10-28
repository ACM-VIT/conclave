import Foundation

// S30 3 (CTL-3): the in-call audio route picker's pure rules, read by both platforms and both test hosts. The WP3
// `AudioRouteOwner` (S30 CC4, SYS-2) is the single routing authority and publishes the one `AudioRouteSnapshot`
// (RECONCILE R23: one route vocabulary); this file turns that snapshot into the Android route sheet's rows (the iOS
// output list is the system `AVRoutePickerView`, S30 Q12), decides when the sheet closes after a person's choice and
// builds the `routeFailed` toast (S30 CC7). RECONCILE R24 and S70 R70-2: with a Bluetooth device present and no
// Android 12+ nearby-devices grant, the owner lists one unnamed row (`AudioRouteOwner.bluetoothAccessOptionId`); the
// sheet shows it with "Allow access to use it" (or "Allow access in Settings" after a permanent denial), and its tap is
// the only `BLUETOOTH_CONNECT` request (SY17). Shared (transpiled): String raw-value enums, scalar structs, arrays of
// structs, no protocols, no associated values.

/// The supporting line under a route row (S30 3 d, f, g).
enum AudioRouteRowLine: String, CaseIterable, Equatable {
    case none, connecting, allowAccess, allowAccessInSettings
}

/// One row of the Android route sheet (S30 CL8 `AudioRouteList`): the owner's option plus the selection state.
struct AudioRouteRowModel: Equatable, Identifiable {
    let id: String
    let kind: AudioRouteKind
    /// The owner's name (a device name, or the platform label); "" means the view resolves the kind's label.
    let name: String
    /// The active route, unless it is the row being switched to.
    let isSelected: Bool
    /// The row the person chose while the owner switches (a spinner replaces its radio, state "Switching").
    let isPending: Bool
    let line: AudioRouteRowLine
    /// The R70-2 nearby-devices row: a tap asks for access instead of routing.
    let isAccessRow: Bool
}

enum RoutePickerPolicy {
    /// The owner fails a request that has not landed within 3 s (S30 3 d "at most 3 s").
    static let switchTimeoutMillis = AudioRouteChangePolicy.requestTimeoutMillis

    static func isAccessRow(_ id: String) -> Bool {
        id == AudioRouteOwner.bluetoothAccessOptionId
    }

    /// The sheet's rows in the owner's order (its default order with the access row last, S70 5 d). The pending row
    /// shows a spinner instead of its radio; the active route keeps its radio until the owner confirms the switch.
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

    /// S30 3 d: after a person's choice the sheet closes once the owner confirmed it (`phase` back to idle with the
    /// chosen route current). For the access row it closes once the grant selected the Bluetooth device (S30 3 d "on
    /// grant the row becomes the named device and the route is selected"); a denial keeps the sheet and the row.
    static func dismissesAfter(requestedId: String, route: AudioRouteSnapshot) -> Bool {
        if requestedId.isEmpty || route.phase != RouteSwitchPhase.idle { return false }
        if isAccessRow(requestedId) {
            return route.bluetoothAccess == BluetoothRouteAccess.notNeeded && route.routeKind == AudioRouteKind.bluetooth
        }
        return route.currentId == requestedId
    }

    /// S30 3 d: the request failed (3 s timeout or a refusal): the row reverts and the sheet stays; the presenter posts
    /// the Retry toast through the owner's `onRouteFailed` (CC7).
    static func requestFailed(requestedId: String, route: AudioRouteSnapshot) -> Bool {
        !requestedId.isEmpty && route.phase == RouteSwitchPhase.failed && route.pendingId == requestedId
    }

    /// S30 CC7 `routeFailed`: "Couldn't switch audio. Try again." with Retry in the stage toast lane (error, no presenter
    /// expiry). `detail` carries the route id the Retry asks for again.
    static func failureNotice(routeId: String) -> MeetingNotice {
        MeetingNotice.make(kind: NoticeKind.routeFailed, severity: NoticeSeverity.error,
                           actions: [NoticeAction.make(NoticeAction.retry)], detail: routeId)
    }

    /// The route id a `routeFailed` notice retries; "" for any other notice.
    static func retryRouteId(_ notice: MeetingNotice) -> String {
        notice.kind == NoticeKind.routeFailed ? notice.detail : ""
    }
}
