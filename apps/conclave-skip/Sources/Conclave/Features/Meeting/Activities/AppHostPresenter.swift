import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Observation

// S60 0.5 and 13 j (ACT-7): the session-owned app host presenter behind the SDK app card on the stage (S20 owns the
// card). Native chrome around one versioned, scoped web renderer per active app (D14): status, host lock and close,
// opening and failure, the Whiteboard tools. Two stored properties, each its own observation unit: `model` (cold: the
// phase, lock, tag and header counts) and `toolbar` (the embed's status and pending commands), so a tool change never
// rebuilds the header and a status burst never rebuilds the failure states. Yjs and awareness never reach this
// presenter (C6-18): the non-observable `ActiveAppSession` relays them. App-owned copy travels as raw values and typed
// enums; each platform maps them through its copy file (`NativeAppHost+iOS.swift` `AppHostCopy`,
// `K/ui/apps/AppHostCopy.kt`). ACT-8 adds Spin the Wheel and Watch Together: the embed adds its page data to `status`
// under `app` (`AppEmbedAppCodec`), which feeds two more observation units, `wheel` and `watch`, read by the card's Spin,
// Edit Names and Queue controls and by the Activities Wheel and Watch pages; page actions are bridge commands
// (`AppPageCommandKind`) with the same pending-until-ack rule. Watch search runs natively through the app backend
// (`WatchSearchService`, `/api/youtube/search`), never in the embed (its page has no network).

enum AppHostPhase: String, CaseIterable, Equatable {
    case opening, ready, readOnly, failed, versionMismatch, closing
}

enum AppHostIssue: String, CaseIterable, Equatable {
    case none, loadFailed, timedOut, versionMismatch, rendererGone
}

/// The card tag under the header (S60 13 f, g).
enum AppHostTag: String, CaseIterable, Equatable {
    case none, viewOnly, lockedForOthers, reconnecting
}

/// Whiteboard bridge commands (C6-19, S60 13 j). Wheel and Watch commands are `AppPageCommandKind` (ACT-8).
enum AppHostCommandKind: String, CaseIterable, Equatable {
    case setTool, setColor, setStrokeWidth, setFill, undo, redo, setPage, addPage, renamePage, deletePage, zoomToFit, export
}

/// Core actions over the existing view model paths: Close (`closeActiveApp()`) and Lock Editing (`toggleAppsLock()`).
enum AppHostCoreCommandKind: String, CaseIterable, Equatable {
    case close, setLocked
}

struct AppHostCoreCommand: Equatable {
    let kind: AppHostCoreCommandKind
    let flag: Bool
}

/// The Whiteboard ink colors: the SDK's flat palette (`apps/whiteboard/shared/constants/tools.ts` TOOL_COLORS). User
/// content, not app palette (S60 13 e, S60R 25); the raw value is the color the embed draws with.
enum AppInkColor: String, CaseIterable, Equatable {
    case white = "#ffffff"
    case mist = "#e3e3e8"
    case gray = "#71717a"
    case charcoal = "#1e1e1e"
    case lightRed = "#f87171"
    case red = "#ef4444"
    case rose = "#fb7185"
    case pink = "#ec4899"
    case lightOrange = "#fb923c"
    case orange = "#f97316"
    case yellow = "#facc15"
    case amber = "#fbbf24"
    case lightGreen = "#4ade80"
    case green = "#22c55e"
    case teal = "#2dd4bf"
    case darkTeal = "#14b8a6"
    case lightBlue = "#60a5fa"
    case blue = "#3b82f6"
    case lavender = "#a8a5ff"
    case purple = "#c084fc"
}

/// Stroke widths (the web's `[` and `]` steps, WhiteboardWebApp.tsx).
enum AppStrokeWidths {
    static let steps: [Int] = [2, 3, 5, 8, 12]
}

/// The Shape menu's fill choice.
enum AppShapeFill: String, CaseIterable, Equatable {
    case outline, filled
}

struct AppHostInputs: Equatable {
    let callSession: Int
    let appId: String
    let isHost: Bool
    let isAttendee: Bool
    let isLocked: Bool
    let isReconnecting: Bool

    static func make(callSession: Int = 0, appId: String = "", isHost: Bool = false, isAttendee: Bool = false,
                     isLocked: Bool = false, isReconnecting: Bool = false) -> AppHostInputs {
        return AppHostInputs(callSession: callSession, appId: appId, isHost: isHost, isAttendee: isAttendee,
                             isLocked: isLocked, isReconnecting: isReconnecting)
    }
}

/// S60 13 j `AppHostModel`, cold part. `reloadSerial` bumps on Try Again: the platform registry then recreates the web
/// view for the same app session (`app.reloads`); everything else keeps the registered instance (`app.registrySerial`).
struct AppHostModel: Equatable {
    let revision: Int
    let appId: String
    let appSessionId: String
    let phase: AppHostPhase
    let issue: AppHostIssue
    let isLocked: Bool
    let canEdit: Bool
    let canClose: Bool
    let canLock: Bool
    let closePending: Bool
    let lockPending: Bool
    let tag: AppHostTag
    let bundleVersion: String
    let editorCount: Int
    /// ACT-8: the Wheel's name count and the Watch playback state ("playing", "paused" or "none") for the header.
    let nameCount: Int
    let playback: String
    let hasEmbed: Bool
    let reloadSerial: Int
    /// Whether the platform host may hold a web view now (opening, ready, read-only, closing). On a failure the host
    /// releases it, and Try Again creates a fresh one.
    let wantsWebView: Bool

    static let empty = AppHostModel(revision: 0, appId: "", appSessionId: "", phase: AppHostPhase.opening, issue: AppHostIssue.none,
                                    isLocked: false, canEdit: false, canClose: false, canLock: false, closePending: false,
                                    lockPending: false, tag: AppHostTag.none, bundleVersion: "", editorCount: 0, nameCount: 0,
                                    playback: "none", hasEmbed: false, reloadSerial: 0, wantsWebView: false)
}

/// S60 13 j, hot part: the embed's status and the commands awaiting their `ack`.
struct AppToolbarModel: Equatable {
    let revision: Int
    let tool: String
    let previousTool: String
    let color: String
    let strokeWidth: Int
    let filled: Bool
    let canUndo: Bool
    let canRedo: Bool
    let pageId: String
    let pageName: String
    let pages: [AppPageModel]
    let elementCount: Int
    /// `AppHostCommandKind` raw values awaiting an ack (the control shows pending).
    let pendingKinds: [String]
    /// Bumps when an exported PNG is ready (`AppHostPresenter.takeExport()`).
    let exportSequence: Int
    let exportFailed: Bool

    func isPending(_ kind: AppHostCommandKind) -> Bool {
        return pendingKinds.contains(kind.rawValue)
    }

    static let empty = AppToolbarModel(revision: 0, tool: AppWhiteboardTool.pen.rawValue, previousTool: AppWhiteboardTool.pen.rawValue,
                                       color: AppInkColor.mist.rawValue, strokeWidth: 3, filled: false, canUndo: false,
                                       canRedo: false, pageId: "", pageName: "", pages: [], elementCount: 0, pendingKinds: [],
                                       exportSequence: 0, exportFailed: false)
}

struct AppHostPendingCommand: Equatable {
    let requestId: String
    let kind: AppHostCommandKind
    let value: String
}

// MARK: ACT-8 Spin the Wheel and Watch Together (S60 13)

/// Spin the Wheel bounds (the SDK `wheel/core/doc`). Twin of `WHEEL_LIMITS` in packages/apps-sdk/src/native-embed/protocol.ts.
enum AppWheelLimits {
    static let entries = 64
    static let label = 48
    static let results = 25
    static let name = 64
}

/// Watch Together bounds for the page data in `status.app`. Twin of `WATCH_LIMITS`.
enum AppWatchLimits {
    static let queue = 50
    static let requests = 50
    static let title = 120
    static let name = 64
    static let userId = 128
}

/// Wheel and Watch bridge commands (S60 13 j, C6-19). Raw values equal the outbound envelope types
/// (`AppBridgeOutboundType`, HD request B8-T2 R1); `AppPagePolicy.outboundType` maps them.
enum AppPageCommandKind: String, CaseIterable, Equatable {
    case addEntries, removeEntry, shuffle, sort, clearEntries, spin, setRemoveWinner, setSounds, clearResults
    case playNow, enqueue, request, approve, decline, cancelRequest, move, remove
}

/// One name on the wheel (user content, shown verbatim).
struct WheelEntryModel: Equatable, Identifiable {
    let id: String
    let label: String
}

/// One settled spin, newest first (the id is the spin id).
struct WheelResultModel: Equatable, Identifiable {
    let id: String
    let label: String
    let byName: String
}

/// One Up Next item.
struct WatchItemModel: Equatable, Identifiable {
    let id: String
    let videoId: String
    let title: String
    let byName: String
}

/// One pending pick from a participant (rides their presence while editing is locked, as on web).
struct WatchRequestModel: Equatable, Identifiable {
    let id: String
    let videoId: String
    let title: String
    let byId: String
    let byName: String
}

/// A search, trending or classic row. The id is the YouTube video id.
struct WatchVideoModel: Equatable, Identifiable {
    let id: String
    let title: String
    let channel: String
}

/// The page data a Wheel or Watch embed adds to `status` under `app` (C6-19 ACT-8). `kind` is "", "wheel" or "watch";
/// fields the kind does not use keep their empty values. Carried on `AppEmbedStatus.app` (HD request B8-T2 R1).
struct AppEmbedAppStatus: Equatable {
    let kind: String
    let entries: [WheelEntryModel]
    let results: [WheelResultModel]
    let removeWinner: Bool
    let sounds: Bool
    let spinning: Bool
    let winnerSpinId: String
    let winnerLabel: String
    let videoId: String
    let title: String
    let playback: String
    let queue: [WatchItemModel]
    let requests: [WatchRequestModel]
    let myRequestId: String
    let requestDeclined: Bool

    static let empty = AppEmbedAppStatus(kind: "", entries: [], results: [], removeWinner: false, sounds: true, spinning: false,
                                         winnerSpinId: "", winnerLabel: "", videoId: "", title: "", playback: "none", queue: [],
                                         requests: [], myRequestId: "", requestDeclined: false)
}

/// Parses `status.app` with the rules of protocol.ts `isValidAppStatus` (the shared fixtures in
/// packages/apps-sdk/src/native-embed/tests/wheel-watch-fixtures.json pin both). Absent is `empty`; anything present
/// must be one of the two kinds, within the bounds, with valid ids, or the whole status is refused (`nil`, badPayload).
enum AppEmbedAppCodec {
    static func parse(_ value: Any?) -> AppEmbedAppStatus? {
        guard let value = value else { return AppEmbedAppStatus.empty }
        guard let object = value as? [String: Any] else { return nil }
        let kind = object["kind"] as? String ?? ""
        if kind == "wheel" { return parseWheel(object) }
        if kind == "watch" { return parseWatch(object) }
        return nil
    }

    private static func parseWheel(_ object: [String: Any]) -> AppEmbedAppStatus? {
        var entries: [WheelEntryModel] = []
        if let rawEntries = object["entries"] {
            guard let list = rawEntries as? [Any], list.count <= AppWheelLimits.entries else { return nil }
            for item in list {
                guard let entry = item as? [String: Any] else { return nil }
                let id = entry["id"] as? String ?? ""
                guard AppBridgeCodec.isValidIdentifier(id),
                      let label = text(entry["label"], limit: AppWheelLimits.label, required: true) else { return nil }
                entries.append(WheelEntryModel(id: id, label: label))
            }
        }
        var results: [WheelResultModel] = []
        if let rawResults = object["results"] {
            guard let list = rawResults as? [Any], list.count <= AppWheelLimits.results else { return nil }
            for item in list {
                guard let result = item as? [String: Any] else { return nil }
                let id = result["id"] as? String ?? ""
                guard AppBridgeCodec.isValidIdentifier(id),
                      let label = text(result["label"], limit: AppWheelLimits.label, required: true),
                      let byName = text(result["byName"], limit: AppWheelLimits.name, required: false) else { return nil }
                results.append(WheelResultModel(id: id, label: label, byName: byName))
            }
        }
        guard let removeWinner = flag(object["removeWinner"], fallback: false),
              let sounds = flag(object["sounds"], fallback: true),
              let spinning = flag(object["spinning"], fallback: false),
              let winnerSpinId = optionalIdentifier(object["winnerSpinId"]),
              let winnerLabel = text(object["winnerLabel"], limit: AppWheelLimits.label, required: false) else { return nil }
        return AppEmbedAppStatus(kind: "wheel", entries: entries, results: results, removeWinner: removeWinner, sounds: sounds,
                                 spinning: spinning, winnerSpinId: winnerSpinId, winnerLabel: winnerLabel, videoId: "", title: "",
                                 playback: "none", queue: [], requests: [], myRequestId: "", requestDeclined: false)
    }

    private static func parseWatch(_ object: [String: Any]) -> AppEmbedAppStatus? {
        var videoId = ""
        if let rawVideo = object["videoId"] {
            guard let value = rawVideo as? String else { return nil }
            if !value.isEmpty && !WatchLinkPolicy.isValidVideoId(value) { return nil }
            videoId = value
        }
        guard let title = text(object["title"], limit: AppWatchLimits.title, required: false) else { return nil }
        var playback = "none"
        if let rawPlayback = object["playback"] {
            guard let value = rawPlayback as? String, value == "playing" || value == "paused" || value == "none" else { return nil }
            playback = value
        }
        var queue: [WatchItemModel] = []
        if let rawQueue = object["queue"] {
            guard let list = rawQueue as? [Any], list.count <= AppWatchLimits.queue else { return nil }
            for item in list {
                guard let entry = item as? [String: Any], let parsed = watchItem(entry) else { return nil }
                queue.append(parsed)
            }
        }
        var requests: [WatchRequestModel] = []
        if let rawRequests = object["requests"] {
            guard let list = rawRequests as? [Any], list.count <= AppWatchLimits.requests else { return nil }
            for item in list {
                guard let entry = item as? [String: Any], let parsed = watchItem(entry),
                      let byId = text(entry["byId"], limit: AppWatchLimits.userId, required: false) else { return nil }
                requests.append(WatchRequestModel(id: parsed.id, videoId: parsed.videoId, title: parsed.title, byId: byId,
                                                  byName: parsed.byName))
            }
        }
        guard let myRequestId = optionalIdentifier(object["myRequestId"]),
              let declined = flag(object["requestDeclined"], fallback: false) else { return nil }
        return AppEmbedAppStatus(kind: "watch", entries: [], results: [], removeWinner: false, sounds: true, spinning: false,
                                 winnerSpinId: "", winnerLabel: "", videoId: videoId, title: title, playback: playback, queue: queue,
                                 requests: requests, myRequestId: myRequestId, requestDeclined: declined)
    }

    private static func watchItem(_ entry: [String: Any]) -> WatchItemModel? {
        let id = entry["id"] as? String ?? ""
        let videoId = entry["videoId"] as? String ?? ""
        guard AppBridgeCodec.isValidIdentifier(id), WatchLinkPolicy.isValidVideoId(videoId),
              let title = text(entry["title"], limit: AppWatchLimits.title, required: false),
              let byName = text(entry["byName"], limit: AppWatchLimits.name, required: false) else { return nil }
        return WatchItemModel(id: id, videoId: videoId, title: title, byName: byName)
    }

    /// A bounded string: absent is "" unless required; a required one must have a non-space character; nil refuses.
    static func text(_ value: Any?, limit: Int, required: Bool) -> String? {
        guard let value = value else { return required ? nil : "" }
        guard let string = value as? String, string.count <= limit else { return nil }
        if required && string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return string
    }

    /// An optional JSON boolean (absent is `fallback`). Text is refused on both platforms; an iOS number also casts to
    /// Bool, so the shared fixtures use JSON booleans only.
    static func flag(_ value: Any?, fallback: Bool) -> Bool? {
        guard let value = value else { return fallback }
        if value is String { return nil }
        return value as? Bool
    }

    /// An optional identifier: absent or "" is "", anything else must be a valid identifier.
    static func optionalIdentifier(_ value: Any?) -> String? {
        guard let value = value else { return "" }
        guard let string = value as? String else { return nil }
        if string.isEmpty { return "" }
        return AppBridgeCodec.isValidIdentifier(string) ? string : nil
    }
}

/// YouTube links and ids for the Watch page (the SDK `watch/core/youtube/id.ts` `parseVideoId`, ported).
enum WatchLinkPolicy {
    private static let idCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

    static func isValidVideoId(_ value: String) -> Bool {
        if value.count != 11 { return false }
        for character in value {
            if !idCharacters.contains(character) { return false }
        }
        return true
    }

    /// The video id in a pasted id or link (watch?v=, youtu.be/, shorts/, embed/, live/, v/); "" when there is none.
    static func videoId(_ raw: String) -> String {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if input.isEmpty { return "" }
        if isValidVideoId(input) { return input }
        let withScheme = input.contains("://") ? input : "https://" + input
        guard let components = URLComponents(string: withScheme), let rawHost = components.host, !rawHost.isEmpty else {
            return looseVideoId(input)
        }
        var host = rawHost.lowercased()
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        let segments = components.path.components(separatedBy: "/").filter { !$0.isEmpty }
        if host == "youtu.be" {
            let id = segments.first ?? ""
            return isValidVideoId(id) ? id : ""
        }
        let isYouTube = host == "youtube.com" || host == "m.youtube.com" || host == "music.youtube.com" || host.hasSuffix(".youtube.com")
        if !isYouTube { return "" }
        // The first "v" only, like URLSearchParams.get.
        if let first = (components.queryItems ?? []).first(where: { $0.name == "v" }), let value = first.value, isValidVideoId(value) {
            return value
        }
        if segments.count >= 2 {
            let prefix = segments[0]
            let candidate = segments[1]
            if (prefix == "shorts" || prefix == "embed" || prefix == "live" || prefix == "v") && isValidVideoId(candidate) {
                return candidate
            }
        }
        return ""
    }

    /// Not a URL: a loose "?v=" or "&v=" followed by an id, as a last resort.
    private static func looseVideoId(_ input: String) -> String {
        let pieces = input.components(separatedBy: "v=")
        var index = 1
        while index < pieces.count {
            let before = pieces[index - 1]
            if before.hasSuffix("?") || before.hasSuffix("&") {
                let candidate = String(pieces[index].prefix(11))
                if isValidVideoId(candidate) { return candidate }
            }
            index += 1
        }
        return ""
    }
}

/// What the Watch page's frame may load (S60 13 c, d; D14): the bundle origin plus, for Watch Together only, the
/// privacy-enhanced YouTube player. Both platform registries ask this (the iOS one through HD request B8-T2 R4), so the
/// embed page's CSP (`frame-src`, packages/apps-sdk/src/native-embed/build) and the native navigation rules agree.
enum AppEmbedFramePolicy {
    static let watchFrameOrigin = "https://www.youtube-nocookie.com"

    /// The CSP `frame-src` value for an app's page.
    static func frameSource(appId: String) -> String {
        return appId == "watch" ? watchFrameOrigin : "'none'"
    }

    /// Whether a subframe navigation may load: only the YouTube embed path, only for Watch Together.
    static func allowsSubframe(appId: String, url: String) -> Bool {
        if appId != "watch" { return false }
        return url.lowercased().hasPrefix(watchFrameOrigin + "/embed/")
    }

    /// Whether the page may start sound or video without a tap inside it: the Wheel's spin sounds follow a native Spin
    /// tap (or someone else's spin) and Watch Together follows the room's playback. The Whiteboard plays nothing.
    static func playsMediaWithoutTap(appId: String) -> Bool {
        return appId == "watch" || appId == "wheel"
    }

    /// Android: whether a subresource request (not the main frame) may go to the network. The Watch page's own CSP
    /// keeps the page itself off the network (connect-src 'none', hash-only scripts), so only the YouTube frame can
    /// make such a request; every other app keeps the empty 403 for anything outside the bundle.
    static func allowsNetworkSubresource(appId: String, url: String, isMainFrame: Bool) -> Bool {
        if appId != "watch" || isMainFrame { return false }
        return url.lowercased().hasPrefix("https://")
    }
}

/// A Watch search or trending answer: the rows, or that search is off on this server (503), or a failure.
struct WatchSearchOutcome: Equatable {
    let items: [WatchVideoModel]
    let unavailable: Bool
    let failed: Bool
}

/// The Watch page's search phase (S60 13 f "watch search off").
enum WatchSearchPhase: String, CaseIterable, Equatable {
    case idle, searching, results, empty, unavailable, failed
}

/// Spin the Wheel, for the card's Spin and Edit Names and the Activities Wheel page (S60 13 c). Its own observation unit.
struct WheelPageModel: Equatable {
    let revision: Int
    let entries: [WheelEntryModel]
    let results: [WheelResultModel]
    let removeWinner: Bool
    let sounds: Bool
    let spinning: Bool
    let canEdit: Bool
    let canSpin: Bool
    let isFull: Bool
    let isReady: Bool
    /// Names of people here who are not on the wheel ("Add Everyone Here", "%lld not on the wheel").
    let missingNames: [String]
    /// `AppPageCommandKind` raw values and targets ("kind:target") awaiting an ack.
    let pendingKinds: [String]
    let pendingTargets: [String]
    /// Bumps when a spin settles live here (the native "Winner: %@" announcement).
    let winnerSequence: Int
    let winnerLabel: String

    func isPending(_ kind: AppPageCommandKind) -> Bool {
        return pendingKinds.contains(kind.rawValue)
    }

    func isPending(_ kind: AppPageCommandKind, target: String) -> Bool {
        return pendingTargets.contains(kind.rawValue + ":" + target)
    }

    func withRevision(_ value: Int) -> WheelPageModel {
        return WheelPageModel(revision: value, entries: entries, results: results, removeWinner: removeWinner, sounds: sounds,
                              spinning: spinning, canEdit: canEdit, canSpin: canSpin, isFull: isFull, isReady: isReady,
                              missingNames: missingNames, pendingKinds: pendingKinds, pendingTargets: pendingTargets,
                              winnerSequence: winnerSequence, winnerLabel: winnerLabel)
    }

    static let empty = WheelPageModel(revision: 0, entries: [], results: [], removeWinner: false, sounds: true, spinning: false,
                                      canEdit: false, canSpin: false, isFull: false, isReady: false, missingNames: [],
                                      pendingKinds: [], pendingTargets: [], winnerSequence: 0, winnerLabel: "")
}

/// Watch Together, for the card's Queue and the Activities Watch page (S60 13 c). Its own observation unit.
struct WatchPageModel: Equatable {
    let revision: Int
    let videoId: String
    let title: String
    let playback: String
    let queue: [WatchItemModel]
    let requests: [WatchRequestModel]
    let myRequestId: String
    let requestDeclined: Bool
    /// Play Now, Add to Queue, reorder and remove: the host, or anyone while Everyone Can Control is on.
    let canControl: Bool
    /// A participant while Everyone Can Control is off: picks become requests.
    let canRequest: Bool
    let isHost: Bool
    let everyoneCanControl: Bool
    let lockPending: Bool
    let isReady: Bool
    let pendingKinds: [String]
    let pendingTargets: [String]
    let searchPhase: WatchSearchPhase
    let query: String
    let results: [WatchVideoModel]
    let trending: [WatchVideoModel]
    /// Bumps when a new video's title is known (the native announcement of the selected video).
    let titleSequence: Int

    func isPending(_ kind: AppPageCommandKind) -> Bool {
        return pendingKinds.contains(kind.rawValue)
    }

    func isPending(_ kind: AppPageCommandKind, target: String) -> Bool {
        return pendingTargets.contains(kind.rawValue + ":" + target)
    }

    /// What a search, trending or classic row does for you now.
    var pickAction: WatchPickAction {
        return AppPagePolicy.pickAction(canControl: canControl, canRequest: canRequest, isPlaying: !videoId.isEmpty)
    }

    /// Your own pending request (the requester's "Pending" row), nil when you have none.
    var myRequest: WatchRequestModel? {
        if myRequestId.isEmpty { return nil }
        return requests.first(where: { $0.id == myRequestId })
    }

    func withRevision(_ value: Int) -> WatchPageModel {
        return WatchPageModel(revision: value, videoId: videoId, title: title, playback: playback, queue: queue, requests: requests,
                              myRequestId: myRequestId, requestDeclined: requestDeclined, canControl: canControl,
                              canRequest: canRequest, isHost: isHost, everyoneCanControl: everyoneCanControl,
                              lockPending: lockPending, isReady: isReady, pendingKinds: pendingKinds,
                              pendingTargets: pendingTargets, searchPhase: searchPhase, query: query, results: results,
                              trending: trending, titleSequence: titleSequence)
    }

    static let empty = WatchPageModel(revision: 0, videoId: "", title: "", playback: "none", queue: [], requests: [], myRequestId: "",
                                      requestDeclined: false, canControl: false, canRequest: false, isHost: false,
                                      everyoneCanControl: true, lockPending: false, isReady: false, pendingKinds: [],
                                      pendingTargets: [], searchPhase: WatchSearchPhase.idle, query: "", results: [], trending: [],
                                      titleSequence: 0)
}

struct AppPagePendingCommand: Equatable {
    let requestId: String
    let kind: AppPageCommandKind
    let target: String
}

/// "Or Start with a Classic" (the SDK `watch/web/crowdPicks.ts`): evergreen, embeddable picks that work with no
/// YouTube key on the server. Titles are content, shown verbatim.
enum WatchClassics {
    static let items: [WatchVideoModel] = [
        WatchVideoModel(id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed"),
        WatchVideoModel(id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up", channel: "Rick Astley"),
        WatchVideoModel(id: "9bZkp7q19f0", title: "PSY - GANGNAM STYLE", channel: "officialpsy"),
        WatchVideoModel(id: "kJQP7kiw5Fk", title: "Luis Fonsi - Despacito ft. Daddy Yankee", channel: "Luis Fonsi"),
        WatchVideoModel(id: "OPf0YbXqDm0", title: "Mark Ronson - Uptown Funk ft. Bruno Mars", channel: "Mark Ronson"),
        WatchVideoModel(id: "4NRXx6U8ABQ", title: "The Weeknd - Blinding Lights", channel: "The Weeknd"),
        WatchVideoModel(id: "fJ9rUzIMcZQ", title: "Queen - Bohemian Rhapsody", channel: "Queen Official"),
        WatchVideoModel(id: "djV11Xbc914", title: "a-ha - Take On Me", channel: "a-ha"),
        WatchVideoModel(id: "FTQbiNvZqaY", title: "Toto - Africa", channel: "Toto"),
        WatchVideoModel(id: "btPJPFnesV4", title: "Survivor - Eye of the Tiger", channel: "Survivor"),
        WatchVideoModel(id: "Gs069dndIYk", title: "Earth, Wind & Fire - September", channel: "Earth, Wind & Fire"),
        WatchVideoModel(id: "ZbZSe6N_BXs", title: "Pharrell Williams - Happy", channel: "Pharrell Williams"),
        WatchVideoModel(id: "L_jWHffIx5E", title: "Smash Mouth - All Star", channel: "Smash Mouth"),
        WatchVideoModel(id: "xuCn8ux2gbs", title: "history of the entire world, i guess", channel: "bill wurtz"),
        WatchVideoModel(id: "h6fcK_fRYaI", title: "The Egg - A Short Story", channel: "Kurzgesagt"),
        WatchVideoModel(id: "aqz-KE-bpKQ", title: "Big Buck Bunny", channel: "Blender"),
        WatchVideoModel(id: "1k8craCGpgs", title: "Journey - Don't Stop Believin'", channel: "Journey"),
        WatchVideoModel(id: "lDK9QqIzhwk", title: "Bon Jovi - Livin' On A Prayer", channel: "Bon Jovi"),
    ]
}

/// What picking a video does on the Watch page (the web's browse modes, WatchEmptyState.tsx): start it for everyone
/// when nothing plays, add it to Up Next while something plays, or ask the host (Everyone Can Control off).
enum WatchPickAction: String, CaseIterable, Equatable {
    case none, playNow, enqueue, request
}

/// Pure Spin the Wheel and Watch Together rules (both platforms' tests pin them).
enum AppPagePolicy {
    private static let spaceCharacters = " \t\n\r\u{0B}\u{0C}\u{A0}"

    /// The SDK's label rule (`wheel/core/doc` normalizeLabel): runs of whitespace become one space, trimmed, at most
    /// 48 characters.
    static func normalizedLabel(_ raw: String) -> String {
        var collapsed = ""
        var pendingSpace = false
        for character in raw {
            if spaceCharacters.contains(character) {
                pendingSpace = !collapsed.isEmpty
                continue
            }
            if pendingSpace {
                collapsed += " "
                pendingSpace = false
            }
            collapsed += String(character)
        }
        return AppBridgeCodec.clipped(collapsed, AppWheelLimits.label)
    }

    /// "Add a Name": one name, or a pasted list with one name per line (S60 13 c), normalized, blanks dropped, at most
    /// `room` names.
    static func wheelLabels(_ raw: String, room: Int) -> [String] {
        var labels: [String] = []
        if room <= 0 { return labels }
        let lines = raw.replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        for line in lines {
            let label = normalizedLabel(line)
            if label.isEmpty { continue }
            labels.append(label)
            if labels.count >= room { break }
        }
        return labels
    }

    /// "Add Everyone Here" (the web's rosterLabels and missingParticipantLabels, WheelWebApp.tsx): roster names, deduped
    /// without case, that no name on the wheel already matches without case.
    static func missingNames(roster: [String], entries: [WheelEntryModel]) -> [String] {
        var existing: [String] = []
        for entry in entries {
            existing.append(entry.label.lowercased())
        }
        var seen: [String] = []
        var missing: [String] = []
        for name in roster {
            let label = normalizedLabel(name)
            if label.isEmpty { continue }
            let key = label.lowercased()
            if seen.contains(key) { continue }
            seen.append(key)
            if existing.contains(key) { continue }
            missing.append(label)
        }
        return missing
    }

    /// Commands the room lock governs (protocol.ts APP_EDIT_COMMANDS): Wheel Sounds is local and a request rides
    /// presence, so a locked participant keeps those.
    static func isEditCommand(_ kind: AppPageCommandKind) -> Bool {
        switch kind {
        case .setSounds, .request, .cancelRequest: return false
        default: return true
        }
    }

    /// Which app a command belongs to ("wheel" or "watch").
    static func appId(_ kind: AppPageCommandKind) -> String {
        switch kind {
        case .addEntries, .removeEntry, .shuffle, .sort, .clearEntries, .spin, .setRemoveWinner, .setSounds, .clearResults:
            return "wheel"
        case .playNow, .enqueue, .request, .approve, .decline, .cancelRequest, .move, .remove:
            return "watch"
        }
    }

    static func outboundType(_ kind: AppPageCommandKind) -> AppBridgeOutboundType {
        switch kind {
        case .addEntries: return AppBridgeOutboundType.addEntries
        case .removeEntry: return AppBridgeOutboundType.removeEntry
        case .shuffle: return AppBridgeOutboundType.shuffle
        case .sort: return AppBridgeOutboundType.sort
        case .clearEntries: return AppBridgeOutboundType.clearEntries
        case .spin: return AppBridgeOutboundType.spin
        case .setRemoveWinner: return AppBridgeOutboundType.setRemoveWinner
        case .setSounds: return AppBridgeOutboundType.setSounds
        case .clearResults: return AppBridgeOutboundType.clearResults
        case .playNow: return AppBridgeOutboundType.playNow
        case .enqueue: return AppBridgeOutboundType.enqueue
        case .request: return AppBridgeOutboundType.request
        case .approve: return AppBridgeOutboundType.approve
        case .decline: return AppBridgeOutboundType.decline
        case .cancelRequest: return AppBridgeOutboundType.cancelRequest
        case .move: return AppBridgeOutboundType.move
        case .remove: return AppBridgeOutboundType.remove
        }
    }

    static func pickAction(canControl: Bool, canRequest: Bool, isPlaying: Bool) -> WatchPickAction {
        if canControl { return isPlaying ? WatchPickAction.enqueue : WatchPickAction.playNow }
        return canRequest ? WatchPickAction.request : WatchPickAction.none
    }

    /// A pasted link always plays (or asks) right away (S60 13 c `.onSubmit(of: .search)`).
    static func linkAction(canControl: Bool, canRequest: Bool) -> WatchPickAction {
        if canControl { return WatchPickAction.playNow }
        return canRequest ? WatchPickAction.request : WatchPickAction.none
    }

    /// The five HTML entities the YouTube Data API leaves in titles.
    static func decodedTitle(_ raw: String) -> String {
        if !raw.contains("&") { return raw }
        return raw.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}

private struct WatchSearchHTTPResult {
    let data: Data
    let statusCode: Int
}

#if SKIP
private struct AndroidWatchSearchHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
    let setCookieHeaders: [String]
}
#endif

/// Watch search and trending through the app backend (S60 13 c, f): `GET {appBaseURL}/api/youtube/search?q=` and
/// `/api/youtube/trending` (apps/web/src/app/api/youtube), so the YouTube key stays on the server and the embed page
/// never reaches the network. A 503 means search is switched off on that server ("Search is switched off on this
/// server. Paste a YouTube link instead."). Reached only through `AppHostPresenter.watchSearch` and `watchTrending`,
/// which the core sets (HD request B8-T2 R3); fixtures set canned rows, so no view calls it.
enum WatchSearchService {
    static let queryLimit = 100
    static let resultLimit = 12
    static let failure = WatchSearchOutcome(items: [], unavailable: false, failed: true)

    static func search(query: String) async -> WatchSearchOutcome {
        let trimmed = AppBridgeCodec.clipped(query.trimmingCharacters(in: .whitespacesAndNewlines), queryLimit)
        if trimmed.isEmpty { return failure }
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = requestURL(path: "/api/youtube/search", query: trimmed, baseURL: baseURL) else { return failure }
        return await fetch(url)
    }

    static func trending() async -> WatchSearchOutcome {
        guard let baseURL = NativeAuthService.resolveAppBaseURL(),
              let url = requestURL(path: "/api/youtube/trending", query: "", baseURL: baseURL) else { return failure }
        return await fetch(url)
    }

    static func requestURL(path: String, query: String, baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        if !query.isEmpty {
            components.queryItems = [URLQueryItem(name: "q", value: query)]
        }
        components.fragment = nil
        return components.url
    }

    /// The route's answer as rows (pure, tested with canned bodies): 503 is "search off", any other non-2xx or an
    /// unreadable body is a failure; rows need a valid video id, are deduped and capped at 12.
    static func decode(statusCode: Int, data: Data) -> WatchSearchOutcome {
        if statusCode == 503 { return WatchSearchOutcome(items: [], unavailable: true, failed: false) }
        if statusCode < 200 || statusCode > 299 { return failure }
        guard let parsed = try? JSONSerialization.jsonObject(with: data), let object = parsed as? [String: Any],
              let list = object["items"] as? [Any] else { return failure }
        var items: [WatchVideoModel] = []
        for raw in list {
            if items.count >= resultLimit { break }
            guard let entry = raw as? [String: Any] else { continue }
            let videoId = entry["videoId"] as? String ?? ""
            if !WatchLinkPolicy.isValidVideoId(videoId) { continue }
            if items.contains(where: { $0.id == videoId }) { continue }
            let title = AppBridgeCodec.clipped(AppPagePolicy.decodedTitle(entry["title"] as? String ?? ""), AppWatchLimits.title)
            let channel = AppBridgeCodec.clipped(AppPagePolicy.decodedTitle(entry["channel"] as? String ?? ""), AppWatchLimits.name)
            items.append(WatchVideoModel(id: videoId, title: title, channel: channel))
        }
        return WatchSearchOutcome(items: items, unavailable: false, failed: false)
    }

    private static func fetch(_ url: URL) async -> WatchSearchOutcome {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let clientId = SfuJoinService.resolveClientId()
        if !clientId.isEmpty {
            request.setValue(clientId, forHTTPHeaderField: "x-sfu-client")
        }
        NativeCookieSupport.attachCookies(to: &request)
        guard let result = try? await performRequest(request, url: url) else { return failure }
        return decode(statusCode: result.statusCode, data: result.data)
    }

    private static func performRequest(_ request: URLRequest, url: URL) async throws -> WatchSearchHTTPResult {
        #if SKIP
        let cookieHeader = request.value(forHTTPHeaderField: "Cookie")
        let rawResponse: String = try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            AndroidNativeHttpClient.requestJson(
                method: request.httpMethod ?? "GET",
                url: url.absoluteString,
                body: nil,
                accept: request.value(forHTTPHeaderField: "Accept"),
                contentType: request.value(forHTTPHeaderField: "Content-Type"),
                origin: request.value(forHTTPHeaderField: "Origin"),
                clientId: request.value(forHTTPHeaderField: "x-sfu-client"),
                cookieHeader: cookieHeader
            ) { response, errorMessage in
                guard !didResume else { return }
                didResume = true
                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).isEmpty {
                    continuation.resume(throwing: NativeAuthError(message: errorMessage))
                    return
                }
                guard let response else {
                    continuation.resume(throwing: NativeAuthError(message: "YouTube search failed."))
                    return
                }
                continuation.resume(returning: response)
            }
        }
        let envelope = try JSONDecoder().decode(AndroidWatchSearchHTTPResponse.self, from: Data(rawResponse.utf8))
        for setCookieHeader in envelope.setCookieHeaders {
            NativeAuthSessionBridge.storeSetCookieHeader(setCookieHeader: setCookieHeader, forURL: url.absoluteString)
        }
        return WatchSearchHTTPResult(data: envelope.body.data(using: String.Encoding.utf8) ?? Data(), statusCode: envelope.statusCode)
        #else
        let (data, response) = try await URLSession.shared.data(for: request)
        NativeCookieSupport.storeCookies(from: response, url: url)
        return WatchSearchHTTPResult(data: data, statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0)
        #endif
    }
}

@MainActor
@Observable
final class AppHostPresenter {
    private(set) var model: AppHostModel = AppHostModel.empty
    private(set) var toolbar: AppToolbarModel = AppToolbarModel.empty
    /// ACT-8: Spin the Wheel and Watch Together (the card's Spin, Edit Names and Queue, the Activities pages), each its
    /// own observation unit, so a names or queue change never rebuilds the header or the Whiteboard toolbar.
    private(set) var wheel: WheelPageModel = WheelPageModel.empty
    private(set) var watch: WatchPageModel = WatchPageModel.empty
    /// `hostActionFailed` for a failed lock or close (S60 13 e, h).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    /// Core only: Close and Lock Editing (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((AppHostCoreCommand) -> Void)? = nil
    /// ACT-8 (HD request B8-T2 R2, `ActivitySession.bindStage()`): opens the Activities panel at an app's page
    /// (`PanelDestination.activitiesApp` with the app id, S60 R6-5).
    @ObservationIgnored var onOpenPage: ((String) -> Void)? = nil
    /// ACT-8 (HD request B8-T2 R3, the view model): Watch search and trending through the app backend
    /// (`WatchSearchService`); the fixture sets canned rows. Nil means search is off ("Search is switched off...").
    @ObservationIgnored var watchSearch: ((String) async -> WatchSearchOutcome)? = nil
    @ObservationIgnored var watchTrending: (() async -> WatchSearchOutcome)? = nil
    /// ACT-8 (HD request B8-T2 R3, the view model): display names of everyone in the call, you included, read when the
    /// Wheel's page data changes, when its page appears and on "Add Everyone Here" (never observed).
    @ObservationIgnored var rosterNames: () -> [String] = { return [] }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// The relay the platform host attaches its web view to (`ActivityWebViewRegistry`, L6-15).
    @ObservationIgnored private(set) var session: ActiveAppSession? = nil
    /// Debug fixtures show the registry readouts (`app.registrySerial`, `app.reloads`, L6-12).
    @ObservationIgnored var showsDebugReadouts = false

    @ObservationIgnored private(set) var inputs = AppHostInputs.make()
    /// Diagnostics for tests (never observed): commands sent, by kind and request id.
    @ObservationIgnored private(set) var commandLog: [String] = []

    @ObservationIgnored private var appSessionId = ""
    @ObservationIgnored private var issue = AppHostIssue.none
    @ObservationIgnored private var bundleVersion = ""
    @ObservationIgnored private var embedReady = false
    @ObservationIgnored private var embedStatus = AppEmbedStatus.empty
    @ObservationIgnored private var previousTool = AppWhiteboardTool.pen.rawValue
    @ObservationIgnored private var closePending = false
    @ObservationIgnored private var lockPending = false
    @ObservationIgnored private var lockTarget = false
    @ObservationIgnored private var reloadSerial = 0
    @ObservationIgnored private var pending: [AppHostPendingCommand] = []
    @ObservationIgnored private var nextRequestNumber = 0
    @ObservationIgnored private var exportSequence = 0
    @ObservationIgnored private var exportFailed = false
    @ObservationIgnored private var exportPNGBase64 = ""
    @ObservationIgnored private var readyTimeoutTask: Task<Void, Never>? = nil
    @ObservationIgnored private var pendingSafetyTask: Task<Void, Never>? = nil
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var toolbarRevision = 0
    // ACT-8 page state.
    @ObservationIgnored private var appStatus = AppEmbedAppStatus.empty
    @ObservationIgnored private var pagePending: [AppPagePendingCommand] = []
    @ObservationIgnored private var lastWinnerSpinId = ""
    @ObservationIgnored private var winnerSequence = 0
    @ObservationIgnored private var winnerLabel = ""
    @ObservationIgnored private var announcedVideoId = ""
    @ObservationIgnored private var titleSequence = 0
    @ObservationIgnored private var searchPhase = WatchSearchPhase.idle
    @ObservationIgnored private var searchQuery = ""
    @ObservationIgnored private var searchResults: [WatchVideoModel] = []
    @ObservationIgnored private var searchSerial = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>? = nil
    @ObservationIgnored private var trendingItems: [WatchVideoModel] = []
    @ObservationIgnored private var trendingRequested = false
    @ObservationIgnored private var wheelRevision = 0
    @ObservationIgnored private var watchRevision = 0
    @ObservationIgnored private var sawAppStatus = false
    /// Fixtures only: names the wheel fixture adds once its embed reports the synced (empty) wheel.
    @ObservationIgnored var fixtureSeedNames: [String] = []

    /// A close or lock with no answer from the core (an admin action already in flight) stops showing pending.
    static let hostActionSafetyMillis = 15000.0

    init() {}

    // MARK: Core hooks

    /// Core only: the relay this presenter drives. Installs the session's event hook.
    func bind(session: ActiveAppSession) {
        self.session = session
        session.onEvent = { [weak self] event in
            self?.apply(event: event)
        }
        followSession()
        rebuild()
    }

    /// Core only: the app, role, lock and connection (S60 13 j inputs). Equality guarded.
    func apply(_ next: AppHostInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            resetLocal()
        }
        let sessionChanged = (session?.appSessionId ?? "") != appSessionId
        if next == inputs && !sessionChanged { return }
        let previous = inputs
        inputs = next
        if lockPending && next.isLocked == lockTarget { finishLock() }
        if closePending && next.appId.isEmpty { closePending = false }
        if next.appId != previous.appId { exportPNGBase64 = "" }
        followSession()
        rebuild()
    }

    /// Core only: the close failed (S60 13 f "closing" returns to the menu item; outcome `hostActionFailed`).
    func closeFailed() {
        if !closePending { return }
        closePending = false
        cancelSafety()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    /// Core only: the lock change failed.
    func lockFailed() {
        if !lockPending { return }
        finishLock()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    /// Session events (ready, failures, the embed's status and acks).
    func apply(event: ActiveAppEvent) {
        switch event.kind {
        case .lifecycle:
            followSession()
            rebuild()
        case .loadStarted:
            followSession()
            if event.appSessionId != appSessionId { return }
            embedReady = false
            issue = AppHostIssue.none
            startReadyTimer()
            rebuild()
        case .ready:
            if event.appSessionId != appSessionId { return }
            embedReady = true
            issue = AppHostIssue.none
            bundleVersion = event.bundleVersion
            cancelReadyTimer()
            rebuild()
        case .failed:
            if event.appSessionId != appSessionId { return }
            embedReady = false
            issue = event.issue
            if !event.bundleVersion.isEmpty { bundleVersion = event.bundleVersion }
            cancelReadyTimer()
            pending = []
            pagePending = []
            rebuild()
            rebuildToolbar()
        case .status:
            if event.appSessionId != appSessionId { return }
            if event.status.tool != embedStatus.tool { previousTool = embedStatus.tool }
            let editorsChanged = event.status.editorCount != embedStatus.editorCount
            embedStatus = event.status
            // ACT-8: a Wheel or Watch embed's page data (HD request B8-T2 R1 carries it on `AppEmbedStatus.app`).
            let app = event.status.app
            let headerChanged = app.entries.count != appStatus.entries.count || app.playback != appStatus.playback
            let first = !sawAppStatus && !app.kind.isEmpty
            if !app.kind.isEmpty { sawAppStatus = true }
            appStatus = app
            noteWinner(app, first: first)
            noteTitle(app, first: first)
            rebuildToolbar()
            rebuildPages()
            if editorsChanged || headerChanged { rebuild() }
            if first { seedFixture(app) }
        case .ack:
            if event.appSessionId != appSessionId { return }
            acknowledge(requestId: event.requestId, ok: event.ok, pngBase64: event.pngBase64)
        }
    }

    // MARK: Actions (views)

    /// Try Again: a fresh web view for the same app session (the registry recreates it on the new `reloadSerial`).
    func retry() {
        if model.hasEmbed == false { return }
        issue = AppHostIssue.none
        embedReady = false
        pending = []
        pagePending = []
        reloadSerial += 1
        cancelReadyTimer()
        rebuild()
        rebuildToolbar()
    }

    /// Close (host, after the confirmation the view owns, R09/D12). Duplicate guarded.
    @discardableResult
    func confirmClose() -> ActivityTapResult {
        if !model.canClose { return ActivityTapResult.explained }
        if closePending { return ActivityTapResult.ignored }
        closePending = true
        startSafety()
        rebuild()
        onCommand?(AppHostCoreCommand(kind: AppHostCoreCommandKind.close, flag: false))
        return ActivityTapResult.dispatched
    }

    /// Lock Editing (host). Pending until the room's lock matches or the core reports a failure.
    @discardableResult
    func setLocked(_ locked: Bool) -> ActivityTapResult {
        if !model.canLock { return ActivityTapResult.explained }
        if lockPending || locked == inputs.isLocked { return ActivityTapResult.ignored }
        lockPending = true
        lockTarget = locked
        startSafety()
        rebuild()
        onCommand?(AppHostCoreCommand(kind: AppHostCoreCommandKind.setLocked, flag: locked))
        return ActivityTapResult.dispatched
    }

    /// One bridge command with a client-local request id; the control shows pending until the matching `ack` (or the
    /// 10 s timeout). `value` and `extra` carry the tool, color, width, fill, page id and page name.
    @discardableResult
    func perform(_ kind: AppHostCommandKind, value: String = "", extra: String = "") -> ActivityTapResult {
        guard let session = session else { return ActivityTapResult.explained }
        if model.phase != AppHostPhase.ready && model.phase != AppHostPhase.readOnly { return ActivityTapResult.explained }
        if AppHostPresenter.isEditCommand(kind) && !model.canEdit { return ActivityTapResult.explained }
        if toolbar.isPending(kind) { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.setTool && value == toolbar.tool { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.undo && !toolbar.canUndo { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.redo && !toolbar.canRedo { return ActivityTapResult.ignored }
        guard let payload = AppHostPresenter.payload(kind, value: value, extra: extra) else { return ActivityTapResult.ignored }
        nextRequestNumber += 1
        let requestId = "h-" + String(nextRequestNumber)
        if !session.sendCommand(AppHostPresenter.outboundType(kind), requestId: requestId, payload: payload) {
            return ActivityTapResult.explained
        }
        commandLog.append(kind.rawValue + ":" + requestId)
        if commandLog.count > 40 { commandLog.removeFirst() }
        if kind == AppHostCommandKind.export { exportFailed = false }
        pending.append(AppHostPendingCommand(requestId: requestId, kind: kind, value: value))
        startCommandTimer(requestId: requestId)
        rebuildToolbar()
        return ActivityTapResult.dispatched
    }

    /// S60 13 c: an Apple Pencil tap or squeeze. Tool switches dispatch here; the menus open in the iOS view.
    @discardableResult
    func pencil(_ response: AppPencilResponse) -> ActivityTapResult {
        switch response {
        case .toggleEraser:
            let target = toolbar.tool == AppWhiteboardTool.eraser.rawValue
                ? (toolbar.previousTool == AppWhiteboardTool.eraser.rawValue ? AppWhiteboardTool.pen.rawValue : toolbar.previousTool)
                : AppWhiteboardTool.eraser.rawValue
            return perform(AppHostCommandKind.setTool, value: target)
        case .previousTool:
            return perform(AppHostCommandKind.setTool, value: toolbar.previousTool)
        case .none, .colorMenu, .strokeMenu, .toolPalette:
            return ActivityTapResult.ignored
        }
    }

    /// The exported PNG (base64) once; "" when none is waiting.
    func takeExport() -> String {
        let value = exportPNGBase64
        exportPNGBase64 = ""
        return value
    }

    // MARK: ACT-8 actions (Spin the Wheel, Watch Together)

    /// Edit Names (Wheel) and Queue (Watch): the Activities panel at the app's page (destination `activitiesApp`, R6-5).
    @discardableResult
    func openPage() -> ActivityTapResult {
        let appId = model.appId
        if appId != "wheel" && appId != "watch" { return ActivityTapResult.explained }
        guard let open = onOpenPage else { return ActivityTapResult.explained }
        open(appId)
        return ActivityTapResult.dispatched
    }

    /// The Wheel page appeared: reread the roster for "Add Everyone Here" and "%lld not on the wheel".
    func refreshRoster() {
        rebuildPages()
    }

    /// The card's Spin (the one primary, S60 13 c): needs spin authority, two names and no spin in progress.
    @discardableResult
    func spinWheel() -> ActivityTapResult {
        if !wheel.canSpin { return wheel.isPending(AppPageCommandKind.spin) || wheel.spinning ? ActivityTapResult.ignored : ActivityTapResult.explained }
        return sendPage(AppPageCommandKind.spin)
    }

    /// "Add a Name": one name or a pasted list (one per line), up to the room left on the wheel.
    @discardableResult
    func addWheelNames(_ raw: String) -> ActivityTapResult {
        if !wheel.canEdit { return ActivityTapResult.explained }
        if wheel.isFull { return ActivityTapResult.explained }
        let labels = AppPagePolicy.wheelLabels(raw, room: AppWheelLimits.entries - wheel.entries.count)
        if labels.isEmpty { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.addEntries, target: "", payload: ["labels": labels])
    }

    /// "Add Everyone Here": everyone in the call whose name is not on the wheel yet.
    @discardableResult
    func addEveryoneToWheel() -> ActivityTapResult {
        if !wheel.canEdit || wheel.isFull { return ActivityTapResult.explained }
        let missing = AppPagePolicy.missingNames(roster: rosterNames(), entries: wheel.entries)
        let room = AppWheelLimits.entries - wheel.entries.count
        var labels: [String] = []
        for name in missing {
            if labels.count >= room { break }
            labels.append(name)
        }
        if labels.isEmpty { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.addEntries, target: "everyone", payload: ["labels": labels])
    }

    @discardableResult
    func removeWheelEntry(_ entryId: String) -> ActivityTapResult {
        if !AppBridgeCodec.isValidIdentifier(entryId) || !wheel.entries.contains(where: { $0.id == entryId }) {
            return ActivityTapResult.ignored
        }
        return sendPage(AppPageCommandKind.removeEntry, target: entryId, payload: ["entryId": entryId])
    }

    @discardableResult
    func shuffleWheel() -> ActivityTapResult {
        if wheel.entries.count < 2 { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.shuffle)
    }

    @discardableResult
    func sortWheel() -> ActivityTapResult {
        if wheel.entries.count < 2 { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.sort)
    }

    /// "Clear Names…" after the view's confirmation.
    @discardableResult
    func clearWheelNames() -> ActivityTapResult {
        if wheel.entries.isEmpty { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.clearEntries)
    }

    @discardableResult
    func setWheelRemoveWinner(_ value: Bool) -> ActivityTapResult {
        if value == wheel.removeWinner { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.setRemoveWinner, payload: ["value": value])
    }

    /// Wheel Sounds is this device's preference (open to everyone, also while locked).
    @discardableResult
    func setWheelSounds(_ value: Bool) -> ActivityTapResult {
        if value == wheel.sounds { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.setSounds, payload: ["value": value])
    }

    @discardableResult
    func clearWheelResults() -> ActivityTapResult {
        if wheel.results.isEmpty { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.clearResults)
    }

    /// The Watch search field's submit (`.onSubmit(of: .search)`, Android ImeAction.Search): a pasted link plays now
    /// (or asks the host); anything else searches through the app backend.
    @discardableResult
    func submitWatchSearch(_ raw: String) -> ActivityTapResult {
        if model.appId != "watch" { return ActivityTapResult.explained }
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            clearWatchSearch()
            return ActivityTapResult.ignored
        }
        let videoId = WatchLinkPolicy.videoId(query)
        if !videoId.isEmpty {
            clearWatchSearch()
            let action = AppPagePolicy.linkAction(canControl: watch.canControl, canRequest: watch.canRequest)
            return pickWatchVideo(WatchVideoModel(id: videoId, title: "", channel: ""), action: action)
        }
        searchSerial += 1
        searchTask?.cancel()
        searchTask = nil
        searchQuery = AppBridgeCodec.clipped(query, WatchSearchService.queryLimit)
        searchResults = []
        guard let search = watchSearch else {
            searchPhase = WatchSearchPhase.unavailable
            rebuildPages()
            return ActivityTapResult.explained
        }
        searchPhase = WatchSearchPhase.searching
        rebuildPages()
        let serial = searchSerial
        let text = searchQuery
        searchTask = Task { @MainActor [weak self] in
            let outcome = await search(text)
            guard let self else { return }
            self.applyWatchSearch(serial: serial, outcome: outcome)
        }
        return ActivityTapResult.dispatched
    }

    /// A search answer; a newer search or a cleared field drops an older one (a test seam).
    func applyWatchSearch(serial: Int, outcome: WatchSearchOutcome) {
        if serial != searchSerial { return }
        searchTask = nil
        if outcome.unavailable {
            searchPhase = WatchSearchPhase.unavailable
            searchResults = []
        } else if outcome.failed {
            searchPhase = WatchSearchPhase.failed
            searchResults = []
        } else {
            var rows: [WatchVideoModel] = []
            for item in outcome.items {
                if rows.count >= WatchSearchService.resultLimit { break }
                rows.append(item)
            }
            searchResults = rows
            searchPhase = rows.isEmpty ? WatchSearchPhase.empty : WatchSearchPhase.results
        }
        rebuildPages()
    }

    /// The field was cleared: back to Trending and the classics.
    func clearWatchSearch() {
        searchSerial += 1
        searchTask?.cancel()
        searchTask = nil
        if searchPhase == WatchSearchPhase.idle && searchQuery.isEmpty && searchResults.isEmpty { return }
        searchPhase = WatchSearchPhase.idle
        searchQuery = ""
        searchResults = []
        rebuildPages()
    }

    /// Trending, once per call (the server caches it); a failure lets the next page visit try again. Without the
    /// backend (search off) only the classics show.
    func loadWatchTrending() {
        if model.appId != "watch" || trendingRequested || !trendingItems.isEmpty { return }
        guard let trending = watchTrending else { return }
        trendingRequested = true
        Task { @MainActor [weak self] in
            let outcome = await trending()
            guard let self else { return }
            self.applyWatchTrending(outcome)
        }
    }

    /// A trending answer (a test seam).
    func applyWatchTrending(_ outcome: WatchSearchOutcome) {
        if outcome.failed || outcome.unavailable {
            trendingRequested = !outcome.failed
            return
        }
        var rows: [WatchVideoModel] = []
        for item in outcome.items {
            if rows.count >= WatchSearchService.resultLimit { break }
            rows.append(item)
        }
        trendingItems = rows
        rebuildPages()
    }

    /// A search, trending or classic row's action (`WatchPageModel.pickAction`): Play Now, Add to Queue or Request.
    @discardableResult
    func pickWatchVideo(_ video: WatchVideoModel, action: WatchPickAction) -> ActivityTapResult {
        if !WatchLinkPolicy.isValidVideoId(video.id) { return ActivityTapResult.ignored }
        let payload: [String: Any] = ["videoId": video.id, "title": AppBridgeCodec.clipped(video.title, AppWatchLimits.title)]
        switch action {
        case .playNow:
            if !watch.canControl { return ActivityTapResult.explained }
            return sendPage(AppPageCommandKind.playNow, target: video.id, payload: payload)
        case .enqueue:
            if !watch.canControl { return ActivityTapResult.explained }
            return sendPage(AppPageCommandKind.enqueue, target: video.id, payload: payload)
        case .request:
            if !watch.canRequest { return ActivityTapResult.explained }
            return sendPage(AppPageCommandKind.request, target: video.id, payload: payload)
        case .none:
            return ActivityTapResult.explained
        }
    }

    /// Up Next's Play Now.
    @discardableResult
    func playQueuedVideo(_ itemId: String) -> ActivityTapResult {
        if !watch.canControl { return ActivityTapResult.explained }
        if !watch.queue.contains(where: { $0.id == itemId }) { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.playNow, target: itemId, payload: ["itemId": itemId])
    }

    /// Up Next reorder (host or Everyone Can Control): direction -1 moves up, 1 moves down, `steps` places (Move Up and
    /// Move Down send one; an iOS drag sends its distance). Clamped to the list.
    @discardableResult
    func moveQueuedVideo(_ itemId: String, direction: Int, steps: Int = 1) -> ActivityTapResult {
        if !watch.canControl { return ActivityTapResult.explained }
        if direction != -1 && direction != 1 { return ActivityTapResult.ignored }
        guard let index = watch.queue.firstIndex(where: { $0.id == itemId }) else { return ActivityTapResult.ignored }
        let room = direction < 0 ? index : watch.queue.count - 1 - index
        let count = min(max(0, steps), room)
        if count == 0 { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.move, target: itemId, payload: ["itemId": itemId, "direction": direction, "steps": count])
    }

    /// An iOS `.onMove` (one row): the SwiftUI destination is the index before which the row lands.
    @discardableResult
    func moveQueuedVideoRow(from source: Int, to destination: Int) -> ActivityTapResult {
        let queue = watch.queue
        if source < 0 || source >= queue.count { return ActivityTapResult.ignored }
        let landing = destination > source ? destination - 1 : destination
        if landing == source { return ActivityTapResult.ignored }
        let direction = landing > source ? 1 : -1
        let steps = landing > source ? landing - source : source - landing
        return moveQueuedVideo(queue[source].id, direction: direction, steps: steps)
    }

    @discardableResult
    func removeQueuedVideo(_ itemId: String) -> ActivityTapResult {
        if !watch.canControl { return ActivityTapResult.explained }
        if !watch.queue.contains(where: { $0.id == itemId }) { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.remove, target: itemId, payload: ["itemId": itemId])
    }

    /// A participant's request: "Add to Queue" (approve) or "Decline", hosts only.
    @discardableResult
    func answerWatchRequest(_ requestId: String, approve: Bool) -> ActivityTapResult {
        if !watch.isHost || !watch.canControl { return ActivityTapResult.explained }
        if !watch.requests.contains(where: { $0.id == requestId }) { return ActivityTapResult.ignored }
        let kind = approve ? AppPageCommandKind.approve : AppPageCommandKind.decline
        return sendPage(kind, target: requestId, payload: ["requestId": requestId])
    }

    /// The requester's "Cancel Request".
    @discardableResult
    func cancelWatchRequest() -> ActivityTapResult {
        if watch.myRequestId.isEmpty { return ActivityTapResult.ignored }
        return sendPage(AppPageCommandKind.cancelRequest)
    }

    /// "Everyone Can Control" (host): playback, seeking and the queue. Off means host only, which is the room's app
    /// lock (as on web, where the lock decides who may write playback), so it rides Lock Editing.
    @discardableResult
    func setWatchEveryoneCanControl(_ value: Bool) -> ActivityTapResult {
        if model.appId != "watch" { return ActivityTapResult.explained }
        return setLocked(!value)
    }

    /// With the S1 reset: nothing pending survives into the next call.
    func reset() {
        resetLocal()
        inputs = AppHostInputs.make()
        trendingItems = []
        trendingRequested = false
        rebuild()
        rebuildToolbar()
        rebuildPages()
    }

    // MARK: Pure rules

    static func isEditCommand(_ kind: AppHostCommandKind) -> Bool {
        switch kind {
        case .setPage, .zoomToFit, .export: return false
        default: return true
        }
    }

    static func canEdit(isAttendee: Bool, isHost: Bool, isLocked: Bool) -> Bool {
        return !isAttendee && (!isLocked || isHost)
    }

    static func phase(hasApp: Bool, hasEmbed: Bool, issue: AppHostIssue, embedReady: Bool, closePending: Bool,
                      canEdit: Bool) -> AppHostPhase {
        if closePending { return AppHostPhase.closing }
        if !hasApp { return AppHostPhase.opening }
        if !hasEmbed || issue == AppHostIssue.versionMismatch { return AppHostPhase.versionMismatch }
        if issue != AppHostIssue.none { return AppHostPhase.failed }
        if !embedReady { return AppHostPhase.opening }
        return canEdit ? AppHostPhase.ready : AppHostPhase.readOnly
    }

    static func tag(isReconnecting: Bool, isLocked: Bool, isHost: Bool) -> AppHostTag {
        if isReconnecting { return AppHostTag.reconnecting }
        if isLocked { return isHost ? AppHostTag.lockedForOthers : AppHostTag.viewOnly }
        return AppHostTag.none
    }

    static func outboundType(_ kind: AppHostCommandKind) -> AppBridgeOutboundType {
        switch kind {
        case .setTool: return AppBridgeOutboundType.setTool
        case .setColor: return AppBridgeOutboundType.setColor
        case .setStrokeWidth: return AppBridgeOutboundType.setStrokeWidth
        case .setFill: return AppBridgeOutboundType.setFill
        case .undo: return AppBridgeOutboundType.undo
        case .redo: return AppBridgeOutboundType.redo
        case .setPage: return AppBridgeOutboundType.setPage
        case .addPage: return AppBridgeOutboundType.addPage
        case .renamePage: return AppBridgeOutboundType.renamePage
        case .deletePage: return AppBridgeOutboundType.deletePage
        case .zoomToFit: return AppBridgeOutboundType.zoomToFit
        case .export: return AppBridgeOutboundType.export
        }
    }

    /// The command payload, or nil when the value is not one the embed accepts (validated here so nothing malformed
    /// crosses the bridge).
    static func payload(_ kind: AppHostCommandKind, value: String, extra: String) -> [String: Any]? {
        switch kind {
        case .setTool:
            if AppWhiteboardTool(rawValue: value) == nil { return nil }
            return ["tool": value]
        case .setColor:
            if AppInkColor(rawValue: value) == nil { return nil }
            return ["color": value]
        case .setStrokeWidth:
            guard let width: Int = Int(value) else { return nil }
            let steps: [Int] = AppStrokeWidths.steps
            if !steps.contains(width) { return nil }
            return ["width": width]
        case .setFill:
            guard let fill = AppShapeFill(rawValue: value) else { return nil }
            return ["filled": fill == AppShapeFill.filled]
        case .setPage, .deletePage:
            if !AppBridgeCodec.isValidIdentifier(value) { return nil }
            return ["pageId": value]
        case .renamePage:
            let name = extra.trimmingCharacters(in: .whitespacesAndNewlines)
            if !AppBridgeCodec.isValidIdentifier(value) || name.isEmpty { return nil }
            return ["pageId": value, "name": AppBridgeCodec.clipped(name, AppBridgeProtocol.pageNameLimit)]
        case .undo, .redo, .addPage, .zoomToFit, .export:
            return [:]
        }
    }

    // MARK: Private

    private func followSession() {
        let current = session?.appSessionId ?? ""
        if current == appSessionId { return }
        appSessionId = current
        issue = AppHostIssue.none
        bundleVersion = ""
        embedReady = false
        embedStatus = AppEmbedStatus.empty
        previousTool = AppWhiteboardTool.pen.rawValue
        pending = []
        exportPNGBase64 = ""
        exportFailed = false
        cancelReadyTimer()
        resetPageState()
        rebuildToolbar()
        rebuildPages()
    }

    private func acknowledge(requestId: String, ok: Bool, pngBase64: String) {
        if let pageIndex = pagePending.firstIndex(where: { $0.requestId == requestId }) {
            pagePending.remove(at: pageIndex)
            rebuildPages()
            return
        }
        guard let index = pending.firstIndex(where: { $0.requestId == requestId }) else { return }
        let entry = pending[index]
        pending.remove(at: index)
        if entry.kind == AppHostCommandKind.export {
            if ok && !pngBase64.isEmpty {
                exportPNGBase64 = pngBase64
                exportSequence += 1
            } else {
                exportFailed = true
            }
        }
        rebuildToolbar()
    }

    private func startCommandTimer(requestId: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppBridgeProtocol.commandTimeoutMillis)
            self.fireCommandTimeout(requestId: requestId)
        }
    }

    /// The 10 s command timeout (a test seam, like `GameStagePresenter.fireTimeout`): the control stops showing pending;
    /// an export that never answered shows its inline failure.
    func fireCommandTimeout(requestId: String) {
        if let pageIndex = pagePending.firstIndex(where: { $0.requestId == requestId }) {
            pagePending.remove(at: pageIndex)
            rebuildPages()
            return
        }
        guard let index = pending.firstIndex(where: { $0.requestId == requestId }) else { return }
        let entry = pending[index]
        pending.remove(at: index)
        if entry.kind == AppHostCommandKind.export { exportFailed = true }
        rebuildToolbar()
    }

    private func startReadyTimer() {
        readyTimeoutTask?.cancel()
        let expectedSession = appSessionId
        let expectedReload = reloadSerial
        readyTimeoutTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppBridgeProtocol.readyTimeoutMillis)
            if Task.isCancelled { return }
            self.fireReadyTimeout(appSessionId: expectedSession, reloadSerial: expectedReload)
        }
    }

    /// The 15 s ready timeout (a test seam): "Couldn't Open" when the load it was started for still has no `ready`.
    func fireReadyTimeout(appSessionId expectedSession: String, reloadSerial expectedReload: Int) {
        if appSessionId != expectedSession || reloadSerial != expectedReload { return }
        if embedReady || issue != AppHostIssue.none { return }
        issue = AppHostIssue.timedOut
        readyTimeoutTask = nil
        rebuild()
    }

    /// True while a ready timeout is armed (tests and the fixture readouts).
    var hasReadyTimer: Bool {
        return readyTimeoutTask != nil
    }

    private func cancelReadyTimer() {
        readyTimeoutTask?.cancel()
        readyTimeoutTask = nil
    }

    private func startSafety() {
        pendingSafetyTask?.cancel()
        pendingSafetyTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppHostPresenter.hostActionSafetyMillis)
            if Task.isCancelled { return }
            self.pendingSafetyTask = nil
            if self.closePending || self.lockPending {
                self.closePending = false
                self.lockPending = false
                self.rebuild()
            }
        }
    }

    private func cancelSafety() {
        if closePending || lockPending { return }
        pendingSafetyTask?.cancel()
        pendingSafetyTask = nil
    }

    private func finishLock() {
        lockPending = false
        cancelSafety()
    }

    private func resetLocal() {
        cancelReadyTimer()
        pendingSafetyTask?.cancel()
        pendingSafetyTask = nil
        appSessionId = session?.appSessionId ?? ""
        issue = AppHostIssue.none
        bundleVersion = ""
        embedReady = false
        embedStatus = AppEmbedStatus.empty
        previousTool = AppWhiteboardTool.pen.rawValue
        closePending = false
        lockPending = false
        pending = []
        exportPNGBase64 = ""
        exportFailed = false
        commandLog = []
        resetPageState()
    }

    private func rebuild() {
        let hasApp = !inputs.appId.isEmpty && !inputs.isAttendee
        let hasEmbed = hasApp && !AppBridgeProtocol.entryFile(appId: inputs.appId).isEmpty
        let canEdit = hasApp && AppHostPresenter.canEdit(isAttendee: inputs.isAttendee, isHost: inputs.isHost, isLocked: inputs.isLocked)
        let phase = AppHostPresenter.phase(hasApp: hasApp, hasEmbed: hasEmbed, issue: issue, embedReady: embedReady,
                                           closePending: closePending, canEdit: canEdit)
        let wantsWebView = hasEmbed && !appSessionId.isEmpty
            && (phase == AppHostPhase.opening || phase == AppHostPhase.ready || phase == AppHostPhase.readOnly || phase == AppHostPhase.closing)
        let next = AppHostModel(
            revision: revision,
            appId: hasApp ? inputs.appId : "",
            appSessionId: hasApp ? appSessionId : "",
            phase: phase,
            issue: hasApp && !hasEmbed ? AppHostIssue.versionMismatch : issue,
            isLocked: inputs.isLocked,
            canEdit: canEdit,
            canClose: hasApp && inputs.isHost,
            canLock: hasApp && inputs.isHost,
            closePending: closePending,
            lockPending: lockPending,
            tag: hasApp ? AppHostPresenter.tag(isReconnecting: inputs.isReconnecting, isLocked: inputs.isLocked, isHost: inputs.isHost) : AppHostTag.none,
            bundleVersion: bundleVersion,
            editorCount: embedStatus.editorCount,
            nameCount: hasApp && inputs.appId == "wheel" && appStatus.kind == "wheel" ? appStatus.entries.count : 0,
            playback: hasApp && inputs.appId == "watch" && appStatus.kind == "watch" ? appStatus.playback : "none",
            hasEmbed: hasEmbed,
            reloadSerial: reloadSerial,
            wantsWebView: wantsWebView
        )
        if AppHostPresenter.sameModel(next, model) {
            rebuildPages()
            return
        }
        revision += 1
        model = AppHostModel(revision: revision, appId: next.appId, appSessionId: next.appSessionId, phase: next.phase,
                             issue: next.issue, isLocked: next.isLocked, canEdit: next.canEdit, canClose: next.canClose,
                             canLock: next.canLock, closePending: next.closePending, lockPending: next.lockPending, tag: next.tag,
                             bundleVersion: next.bundleVersion, editorCount: next.editorCount, nameCount: next.nameCount,
                             playback: next.playback, hasEmbed: next.hasEmbed, reloadSerial: next.reloadSerial,
                             wantsWebView: next.wantsWebView)
        rebuildPages()
    }

    private func rebuildToolbar() {
        var kinds: [String] = []
        for entry in pending {
            if !kinds.contains(entry.kind.rawValue) { kinds.append(entry.kind.rawValue) }
        }
        let next = AppToolbarModel(revision: toolbarRevision, tool: embedStatus.tool, previousTool: previousTool,
                                   color: embedStatus.color, strokeWidth: embedStatus.strokeWidth, filled: embedStatus.filled,
                                   canUndo: embedStatus.canUndo, canRedo: embedStatus.canRedo, pageId: embedStatus.pageId,
                                   pageName: embedStatus.pageName, pages: embedStatus.pages,
                                   elementCount: embedStatus.elementCount, pendingKinds: kinds, exportSequence: exportSequence,
                                   exportFailed: exportFailed)
        if AppHostPresenter.sameToolbar(next, toolbar) { return }
        toolbarRevision += 1
        toolbar = AppToolbarModel(revision: toolbarRevision, tool: next.tool, previousTool: next.previousTool, color: next.color,
                                  strokeWidth: next.strokeWidth, filled: next.filled, canUndo: next.canUndo, canRedo: next.canRedo,
                                  pageId: next.pageId, pageName: next.pageName, pages: next.pages, elementCount: next.elementCount,
                                  pendingKinds: next.pendingKinds, exportSequence: next.exportSequence,
                                  exportFailed: next.exportFailed)
    }

    /// Equal apart from the revision.
    static func sameModel(_ a: AppHostModel, _ b: AppHostModel) -> Bool {
        return a.appId == b.appId && a.appSessionId == b.appSessionId && a.phase == b.phase && a.issue == b.issue
            && a.isLocked == b.isLocked && a.canEdit == b.canEdit && a.canClose == b.canClose && a.canLock == b.canLock
            && a.closePending == b.closePending && a.lockPending == b.lockPending && a.tag == b.tag
            && a.bundleVersion == b.bundleVersion && a.editorCount == b.editorCount && a.nameCount == b.nameCount
            && a.playback == b.playback && a.hasEmbed == b.hasEmbed && a.reloadSerial == b.reloadSerial
            && a.wantsWebView == b.wantsWebView
    }

    static func sameToolbar(_ a: AppToolbarModel, _ b: AppToolbarModel) -> Bool {
        return a.tool == b.tool && a.previousTool == b.previousTool && a.color == b.color && a.strokeWidth == b.strokeWidth
            && a.filled == b.filled && a.canUndo == b.canUndo && a.canRedo == b.canRedo && a.pageId == b.pageId
            && a.pageName == b.pageName && a.pages == b.pages && a.elementCount == b.elementCount
            && a.pendingKinds == b.pendingKinds && a.exportSequence == b.exportSequence && a.exportFailed == b.exportFailed
    }

    private func publishFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }

    // MARK: ACT-8 private

    /// One Wheel or Watch bridge command with a client-local request id, pending until its `ack` or the 10 s timeout.
    /// The same command for the same target is not sent twice while pending (adding names always goes through).
    @discardableResult
    private func sendPage(_ kind: AppPageCommandKind, target: String = "", payload: [String: Any] = [:]) -> ActivityTapResult {
        guard let session = session else { return ActivityTapResult.explained }
        if model.phase != AppHostPhase.ready && model.phase != AppHostPhase.readOnly { return ActivityTapResult.explained }
        if AppPagePolicy.appId(kind) != model.appId || appStatus.kind != model.appId { return ActivityTapResult.explained }
        if AppPagePolicy.isEditCommand(kind) && !model.canEdit { return ActivityTapResult.explained }
        if kind != AppPageCommandKind.addEntries
            && pagePending.contains(where: { $0.kind == kind && $0.target == target }) {
            return ActivityTapResult.ignored
        }
        nextRequestNumber += 1
        let requestId = "h-" + String(nextRequestNumber)
        if !session.sendCommand(AppPagePolicy.outboundType(kind), requestId: requestId, payload: payload) {
            return ActivityTapResult.explained
        }
        commandLog.append(kind.rawValue + ":" + requestId)
        if commandLog.count > 40 { commandLog.removeFirst() }
        pagePending.append(AppPagePendingCommand(requestId: requestId, kind: kind, target: target))
        startCommandTimer(requestId: requestId)
        rebuildPages()
        return ActivityTapResult.dispatched
    }

    /// A spin that settled live in this embed (never a replayed one) becomes the native "Winner: %@" announcement.
    private func noteWinner(_ app: AppEmbedAppStatus, first: Bool) {
        if app.kind != "wheel" { return }
        if first {
            lastWinnerSpinId = app.winnerSpinId
            return
        }
        if app.winnerSpinId.isEmpty || app.winnerSpinId == lastWinnerSpinId || app.winnerLabel.isEmpty { return }
        lastWinnerSpinId = app.winnerSpinId
        winnerLabel = app.winnerLabel
        winnerSequence += 1
    }

    /// A newly selected video is announced natively once its title is known; the video already playing when the page
    /// data first arrives is not.
    private func noteTitle(_ app: AppEmbedAppStatus, first: Bool) {
        if app.kind != "watch" { return }
        if first {
            announcedVideoId = app.videoId
            return
        }
        if app.videoId.isEmpty {
            announcedVideoId = ""
            return
        }
        if app.videoId == announcedVideoId || app.title.isEmpty { return }
        announcedVideoId = app.videoId
        titleSequence += 1
    }

    /// The wheel fixture's names, added once the embed reports its synced wheel (no socket: the fixture relay records
    /// the update the embed sends).
    private func seedFixture(_ app: AppEmbedAppStatus) {
        if fixtureSeedNames.isEmpty || app.kind != "wheel" { return }
        let names = fixtureSeedNames
        fixtureSeedNames = []
        _ = addWheelNames(names.joined(separator: "\n"))
    }

    private func resetPageState() {
        appStatus = AppEmbedAppStatus.empty
        pagePending = []
        sawAppStatus = false
        lastWinnerSpinId = ""
        winnerLabel = ""
        announcedVideoId = ""
        searchSerial += 1
        searchTask?.cancel()
        searchTask = nil
        searchPhase = WatchSearchPhase.idle
        searchQuery = ""
        searchResults = []
    }

    /// The two page models, each published only when something in it changed (its own revision).
    private func rebuildPages() {
        let ready = model.phase == AppHostPhase.ready || model.phase == AppHostPhase.readOnly
        var kinds: [String] = []
        var targets: [String] = []
        for entry in pagePending {
            if !kinds.contains(entry.kind.rawValue) { kinds.append(entry.kind.rawValue) }
            targets.append(entry.kind.rawValue + ":" + entry.target)
        }

        let isWheel = model.appId == "wheel" && appStatus.kind == "wheel"
        let wheelEntries = isWheel ? appStatus.entries : []
        let wheelEdit = isWheel && ready && model.canEdit
        let spinning = isWheel && appStatus.spinning
        let missing = wheelEdit ? AppPagePolicy.missingNames(roster: rosterNames(), entries: wheelEntries) : []
        let nextWheel = WheelPageModel(
            revision: wheel.revision,
            entries: wheelEntries,
            results: isWheel ? appStatus.results : [],
            removeWinner: isWheel && appStatus.removeWinner,
            sounds: isWheel ? appStatus.sounds : true,
            spinning: spinning,
            canEdit: wheelEdit,
            canSpin: wheelEdit && wheelEntries.count >= 2 && !spinning && !kinds.contains(AppPageCommandKind.spin.rawValue),
            isFull: wheelEntries.count >= AppWheelLimits.entries,
            isReady: isWheel && ready,
            missingNames: missing,
            pendingKinds: isWheel ? kinds : [],
            pendingTargets: isWheel ? targets : [],
            winnerSequence: winnerSequence,
            winnerLabel: winnerLabel
        )
        if nextWheel != wheel {
            wheelRevision += 1
            wheel = nextWheel.withRevision(wheelRevision)
        }

        let isWatch = model.appId == "watch" && appStatus.kind == "watch"
        let watchApp = model.appId == "watch" && ready
        let nextWatch = WatchPageModel(
            revision: watch.revision,
            videoId: isWatch ? appStatus.videoId : "",
            title: isWatch ? appStatus.title : "",
            playback: isWatch ? appStatus.playback : "none",
            queue: isWatch ? appStatus.queue : [],
            requests: isWatch ? appStatus.requests : [],
            myRequestId: isWatch ? appStatus.myRequestId : "",
            requestDeclined: isWatch && appStatus.requestDeclined,
            canControl: isWatch && watchApp && model.canEdit,
            canRequest: isWatch && watchApp && !model.canEdit && !inputs.isAttendee,
            isHost: model.appId == "watch" && inputs.isHost,
            everyoneCanControl: !inputs.isLocked,
            lockPending: model.lockPending,
            isReady: isWatch && watchApp,
            pendingKinds: isWatch ? kinds : [],
            pendingTargets: isWatch ? targets : [],
            searchPhase: model.appId == "watch" ? searchPhase : WatchSearchPhase.idle,
            query: model.appId == "watch" ? searchQuery : "",
            results: model.appId == "watch" ? searchResults : [],
            trending: trendingItems,
            titleSequence: titleSequence
        )
        if nextWatch != watch {
            watchRevision += 1
            watch = nextWatch.withRevision(watchRevision)
        }
    }
}

// MARK: Fixtures (L6-12)

/// `app-*` fixture states for the S20 SL14 stage fixture (layered on `app-opening` by HD request B7-T1 R5). No socket,
/// network, audio or capture: a fixture `ActiveAppSession` answers sync with an empty document and records the bytes
/// the embed would send. The real bundled embed loads from the app bundle (local assets only).
enum AppHostFixtureState: String, CaseIterable, Equatable {
    case whiteboardReady = "app-whiteboard-ready"
    case whiteboardViewOnly = "app-whiteboard-view-only"
    case whiteboardLockedHost = "app-whiteboard-locked-host"
    case whiteboardReconnecting = "app-whiteboard-reconnecting"
    case versionMismatch = "app-version-mismatch"
    case rendererGone = "app-renderer-gone"
}

@MainActor
final class AppHostFixtureOwner {
    private(set) var updates = 0
    private(set) var awareness = 0
    private(set) var syncs = 0
    private(set) var coreCommands: [String] = []

    func record(_ command: AppHostCoreCommand) {
        coreCommands.append(command.kind.rawValue + (command.kind == AppHostCoreCommandKind.setLocked ? (command.flag ? ":on" : ":off") : ""))
    }

    /// ACT-8: Edit Names and Queue open the Activities page (the fixture records the app id).
    private(set) var pages: [String] = []

    func recordPage(_ appId: String) {
        pages.append(appId)
    }

    func recordUpdate() { updates += 1 }
    func recordAwareness() { awareness += 1 }
    func recordSync() { syncs += 1 }
}

/// ACT-8 `app-*` fixture states for Spin the Wheel and Watch Together (S60 13 l), layered the same way. A separate enum
/// keeps the ACT-7 states' exhaustive switches intact. No socket, network, audio or capture: the bundled embeds load
/// from the app; the wheel fixture adds its names through the embed once it reports the synced wheel; Watch search and
/// trending answer from canned rows (no YouTube request; nothing plays until someone picks a video, which needs the
/// owner-session network cell).
enum AppPageFixtureState: String, CaseIterable, Equatable {
    case wheelReady = "app-wheel-ready"
    case wheelViewOnly = "app-wheel-view-only"
    case watchHost = "app-watch-host"
    case watchParticipant = "app-watch-participant"
    case watchSearchOff = "app-watch-search-off"
}

enum AppHostFixtures {
    static let wheelNames = ["Ada", "Ben", "Chidi", "Dara", "Eli", "Fen"]
    static let rosterNames = ["You", "Ada", "Ben", "Grace", "Hiro", "Ines"]
    static let trending: [WatchVideoModel] = [
        WatchVideoModel(id: "aqz-KE-bpKQ", title: "Big Buck Bunny", channel: "Blender"),
        WatchVideoModel(id: "h6fcK_fRYaI", title: "The Egg - A Short Story", channel: "Kurzgesagt"),
        WatchVideoModel(id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed"),
    ]

    static func state(named raw: String) -> AppHostFixtureState? {
        return AppHostFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func pageState(named raw: String) -> AppPageFixtureState? {
        return AppPageFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isFixture(_ raw: String) -> Bool {
        return state(named: raw) != nil || pageState(named: raw) != nil
    }

    /// The SDK app a fixture opens (the stage and launcher layers use it; HD request B8-T2 R6).
    static func appId(named raw: String) -> String {
        guard let page = pageState(named: raw) else { return "whiteboard" }
        switch page {
        case .wheelReady, .wheelViewOnly: return "wheel"
        case .watchHost, .watchParticipant, .watchSearchOff: return "watch"
        }
    }

    /// Binds `presenter` to a fixture relay and scripts the state. Returns the relay (the caller keeps it alive with the
    /// fixture session).
    @discardableResult
    @MainActor
    static func apply(named raw: String, presenter: AppHostPresenter, owner: AppHostFixtureOwner) -> ActiveAppSession? {
        if let page = pageState(named: raw) { return applyPage(page, presenter: presenter, owner: owner) }
        guard let state = state(named: raw) else { return nil }
        let relay = ActiveAppSession()
        relay.syncTransport = { [weak owner] _, _ in
            owner?.recordSync()
            return AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil)
        }
        relay.updateTransport = { [weak owner] _, _ in owner?.recordUpdate() }
        relay.awarenessTransport = { [weak owner] _, _, _ in owner?.recordAwareness() }
        presenter.onCommand = { [weak owner] command in owner?.record(command) }
        presenter.showsDebugReadouts = true
        presenter.bind(session: relay)
        let host = state != .whiteboardViewOnly
        let locked = state == .whiteboardViewOnly || state == .whiteboardLockedHost
        relay.begin(appId: "whiteboard", callSessionId: "fixture-call", isReadOnly: locked && !host)
        relay.setUser(id: "fixture-you", name: "You")
        presenter.apply(AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: host, isLocked: locked,
                                           isReconnecting: state == .whiteboardReconnecting))
        if state == .whiteboardReconnecting { relay.setConnection(live: false) }
        if state == .versionMismatch {
            presenter.apply(event: ActiveAppEvent.make(kind: ActiveAppEventKind.failed, appSessionId: relay.appSessionId,
                                                       lifecycle: ActiveAppLifecycle.failed, issue: AppHostIssue.versionMismatch,
                                                       bundleVersion: "2.0.0"))
        } else if state == .rendererGone {
            relay.embedFailed(appSessionId: relay.appSessionId, issue: AppHostIssue.rendererGone)
        }
        return relay
    }

    private static func applyPage(_ state: AppPageFixtureState, presenter: AppHostPresenter, owner: AppHostFixtureOwner) -> ActiveAppSession {
        let relay = ActiveAppSession()
        relay.syncTransport = { [weak owner] _, _ in
            owner?.recordSync()
            return AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil)
        }
        relay.updateTransport = { [weak owner] _, _ in owner?.recordUpdate() }
        relay.awarenessTransport = { [weak owner] _, _, _ in owner?.recordAwareness() }
        presenter.onCommand = { [weak owner] command in owner?.record(command) }
        // The stage fixture's `ActivitySession.bindStage()` already routes Edit Names and Queue to the Activities panel;
        // a bare presenter (tests) records them instead.
        if presenter.onOpenPage == nil {
            presenter.onOpenPage = { [weak owner] appId in owner?.recordPage(appId) }
        }
        presenter.rosterNames = { return AppHostFixtures.rosterNames }
        presenter.showsDebugReadouts = true
        let fixtureApp = AppHostFixtures.appId(named: state.rawValue)
        let host = state == .wheelReady || state == .watchHost || state == .watchSearchOff
        let locked = state == .wheelViewOnly || state == .watchParticipant
        if state == .watchSearchOff {
            presenter.watchSearch = nil
            presenter.watchTrending = nil
        } else {
            presenter.watchSearch = { query in
                return WatchSearchOutcome(items: AppHostFixtures.trending.filter { $0.title.lowercased().contains(query.lowercased()) },
                                          unavailable: false, failed: false)
            }
            presenter.watchTrending = {
                return WatchSearchOutcome(items: AppHostFixtures.trending, unavailable: false, failed: false)
            }
        }
        presenter.fixtureSeedNames = state == .wheelReady ? AppHostFixtures.wheelNames : []
        presenter.bind(session: relay)
        relay.begin(appId: fixtureApp, callSessionId: "fixture-call", isReadOnly: locked && !host)
        relay.setUser(id: "fixture-you", name: "You")
        presenter.apply(AppHostInputs.make(callSession: 1, appId: fixtureApp, isHost: host, isLocked: locked))
        return relay
    }
}
