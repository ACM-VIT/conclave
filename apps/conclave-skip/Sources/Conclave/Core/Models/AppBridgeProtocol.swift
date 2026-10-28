import Foundation

// S60 0.8 C6-19 and S60R 25 (ACT-7): the versioned native embed bridge between the native app host and the bundled SDK
// renderer (`packages/apps-sdk/src/native-embed/`, `protocol.ts` is the JavaScript twin of this file and
// `contract-fixtures.json` pins both). Shared and transpiled, so iOS (`WKScriptMessageHandler`) and Android
// (`WebViewCompat.addWebMessageListener`) validate every message with the same rules before anything is dispatched.
//
// Envelope (one JSON object per message, both directions):
//   { "v": 1, "type": "<type>", "callSessionId": "<id>", "appSessionId": "<id>", "requestId": "<id>", "payload": {...} }
// Embed to native: ready, sync, update, awareness, status, ack, resize.
// Native to embed: snapshot, update, awareness, status, resync, close and the host commands (setTool, setColor,
// setStrokeWidth, setFill, undo, redo, setPage, addPage, renamePage, deletePage, zoomToFit, export).
// Binary Yjs and awareness payloads travel as base64. The bridge never carries auth tokens, personal API keys or native
// method names (D14): the embed has no socket and no network (its page CSP sets connect-src 'none'); the native
// session relays the room's Yjs bytes and nothing else. A rejected message is counted by reason, never logged with its
// content (S60 13 l).

enum AppBridgeProtocol {
    /// The envelope version both sides speak. A `ready` with another value is a version mismatch (S60 13 f).
    static let version = 1
    /// The embed bundle's major version this build accepts (`ready.payload.bundleVersion` "1.x.y").
    static let bundleMajor = 1
    /// The `WKScriptMessageHandler` and `addWebMessageListener` object name (S60 13 c, d).
    static let handlerName = "conclaveApp"

    /// The bundle origins. iOS serves the bundle from a `WKURLSchemeHandler`; Android from `WebViewAssetLoader`.
    static let iosScheme = "conclave-embed"
    static let iosHost = "app"
    static let iosOrigin = "conclave-embed://app"
    static let androidOrigin = "https://appassets.androidplatform.net"

    /// Size bounds. The SFU limits (packages/sfu/server/socket/handlers/appsHandlers.ts:20-24) bound the relayed
    /// bytes; the envelope bound leaves room for a 1 MiB snapshot in base64.
    static let envelopeCharacterLimit = 1_572_864
    static let updateByteLimit = 262_144
    static let awarenessByteLimit = 65_536
    static let stateVectorByteLimit = 65_536
    static let snapshotByteLimit = 1_048_576
    static let exportByteLimit = 1_048_576
    static let identifierLimit = 64
    static let pageLimit = 50
    static let pageNameLimit = 40
    /// A remembered window of embed request ids, so a replayed message is dropped (`duplicateRequest`).
    static let requestMemory = 64

    /// The embed must say `ready` within this time after the load starts, else the card shows "Couldn't Open" (S60 13 f).
    static let readyTimeoutMillis = 15000.0
    /// A host command shows pending until its `ack`, at most this long (S60 13 j).
    static let commandTimeoutMillis = 10000.0

    /// The bundled entry for an SDK app id, or "" when this build has no embed for it (Wheel and Watch land with ACT-8;
    /// until then the card shows the version mismatch state: "Update Conclave to use %@.").
    static func entryFile(appId: String) -> String {
        if appId == "whiteboard" { return "whiteboard.html" }
        return ""
    }

    /// iOS: the bundle resource name (`Resources/native-embed-whiteboard.html`, flattened by SwiftPM `.process`).
    static func iosResourceName(appId: String) -> String {
        if entryFile(appId: appId).isEmpty { return "" }
        return "native-embed-" + appId
    }

    /// Android: the asset path under `app/src/main/assets/` served by `WebViewAssetLoader` at `/assets/`.
    static func androidAssetPath(appId: String) -> String {
        let file = entryFile(appId: appId)
        if file.isEmpty { return "" }
        return "native-embed/" + file
    }

    /// The fragment that scopes one load: never sent anywhere (a fragment is not part of a request), read once by the
    /// embed and echoed in every envelope it sends.
    static func fragment(callSessionId: String, appSessionId: String, appId: String) -> String {
        return "#v=" + String(version) + "&callSessionId=" + callSessionId + "&appSessionId=" + appSessionId + "&appId=" + appId
    }

    static func iosEntryURL(appId: String, callSessionId: String, appSessionId: String) -> String {
        let file = entryFile(appId: appId)
        if file.isEmpty { return "" }
        return iosOrigin + "/" + file + fragment(callSessionId: callSessionId, appSessionId: appSessionId, appId: appId)
    }

    static func androidEntryURL(appId: String, callSessionId: String, appSessionId: String) -> String {
        let path = androidAssetPath(appId: appId)
        if path.isEmpty { return "" }
        return androidOrigin + "/assets/" + path + fragment(callSessionId: callSessionId, appSessionId: appSessionId, appId: appId)
    }

    /// Whether a navigation target stays inside the bundle origin (everything else is cancelled; a user link asks first).
    static func isBundleURL(_ url: String, origin: String) -> Bool {
        let lower = url.lowercased()
        let prefix = origin.lowercased() + "/"
        return lower.hasPrefix(prefix)
    }

    /// A user-initiated external link the host may offer to open after the confirmation (S40 link policy).
    static func isOpenableExternalLink(_ url: String) -> Bool {
        let lower = url.lowercased()
        return lower.hasPrefix("https://") || lower.hasPrefix("http://")
    }
}

/// Embed to native.
enum AppBridgeInboundType: String, CaseIterable, Equatable {
    case ready, sync, update, awareness, status, ack, resize
}

/// Native to embed.
enum AppBridgeOutboundType: String, CaseIterable, Equatable {
    case snapshot, update, awareness, status, resync, close
    case setTool, setColor, setStrokeWidth, setFill, undo, redo, setPage, addPage, renamePage, deletePage, zoomToFit, export
}

/// Why an inbound message was dropped. Counted and surfaced by reason only, never with its content.
enum AppBridgeRejection: String, CaseIterable, Equatable {
    case none, wrongOrigin, notMainFrame, oversized, malformed, versionMismatch, unknownType, wrongCallSession, staleAppSession
    case badRequestId, duplicateRequest, badPayload, payloadTooLarge, notAttached
}

/// The Whiteboard tools the native toolbar drives (the embed's `ToolKind`, SDK `core/tools/engine.ts`). Shape tools are
/// rect, ellipse, line and arrow (the Shape menu, S60 13 c).
enum AppWhiteboardTool: String, CaseIterable, Equatable {
    case select, pan, pen, highlighter, eraser, rect, ellipse, line, arrow, text, sticky, laser

    var isShape: Bool {
        return self == .rect || self == .ellipse || self == .line || self == .arrow
    }
}

/// One whiteboard page (S60 13 j `AppPageModel`). The name is user content, shown verbatim.
struct AppPageModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isCurrent: Bool
}

/// The embed's own `status` (tool, ink, history, pages, presence). Bounded and typed before it reaches a presenter.
struct AppEmbedStatus: Equatable {
    let tool: String
    let color: String
    let strokeWidth: Int
    let filled: Bool
    let canUndo: Bool
    let canRedo: Bool
    let pageId: String
    let pageName: String
    let pages: [AppPageModel]
    let elementCount: Int
    let editorCount: Int

    static let empty = AppEmbedStatus(tool: AppWhiteboardTool.pen.rawValue, color: "#e3e3e8", strokeWidth: 3, filled: false,
                                      canUndo: false, canRedo: false, pageId: "", pageName: "", pages: [],
                                      elementCount: 0, editorCount: 0)
}

/// What the session expects of every inbound envelope.
struct AppBridgeExpectation: Equatable {
    let origin: String
    let callSessionId: String
    let appSessionId: String
}

/// One validated inbound message. Fields that the type does not use keep their empty values.
struct AppBridgeInbound: Equatable {
    let type: String
    let requestId: String
    let version: Int
    /// `ready`: the bundle's version ("1.0.0") and app id.
    let bundleVersion: String
    let appId: String
    /// `ready` and `sync`: the embed document's state vector; `update`: the Yjs update; `awareness`: the update.
    let bytes: Data
    /// `awareness`: the Yjs client id, -1 when absent.
    let clientId: Int
    /// `ack`: the command's outcome, an error code from the embed (never shown) and the exported PNG for `export`.
    let ok: Bool
    let error: String
    let pngBase64: String
    /// `status`.
    let status: AppEmbedStatus
    /// `resize`.
    let width: Int
    let height: Int

    static func make(type: String, requestId: String = "", version: Int = AppBridgeProtocol.version, bundleVersion: String = "",
                     appId: String = "", bytes: Data = Data(), clientId: Int = -1, ok: Bool = false, error: String = "",
                     pngBase64: String = "", status: AppEmbedStatus = AppEmbedStatus.empty, width: Int = 0,
                     height: Int = 0) -> AppBridgeInbound {
        return AppBridgeInbound(type: type, requestId: requestId, version: version, bundleVersion: bundleVersion, appId: appId,
                                bytes: bytes, clientId: clientId, ok: ok, error: error, pngBase64: pngBase64, status: status,
                                width: width, height: height)
    }

    static let none = AppBridgeInbound.make(type: "")
}

struct AppBridgeDecodeResult: Equatable {
    let rejection: AppBridgeRejection
    let message: AppBridgeInbound

    static func rejected(_ rejection: AppBridgeRejection) -> AppBridgeDecodeResult {
        return AppBridgeDecodeResult(rejection: rejection, message: AppBridgeInbound.none)
    }
}

/// Parses, validates and encodes envelopes. Pure: no state, so a hostile message can be checked in a unit test on both
/// platforms (T/ACT7AppHostTests.swift, T/Skip/ACT7AppHostBridgeTests.kt) and against the shared contract fixtures.
enum AppBridgeCodec {
    private static let identifierCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"
    private static let hexCharacters = "0123456789abcdefABCDEF"

    /// Order of checks (each is cheap before the next): origin and frame, size, JSON object, version, type, call and app
    /// session, request id, then the payload for the type. Replay detection lives in the session (it remembers ids).
    static func decode(raw: String, origin: String, isMainFrame: Bool, expectation: AppBridgeExpectation) -> AppBridgeDecodeResult {
        if !originMatches(origin, expected: expectation.origin) { return AppBridgeDecodeResult.rejected(.wrongOrigin) }
        if !isMainFrame { return AppBridgeDecodeResult.rejected(.notMainFrame) }
        if raw.count > AppBridgeProtocol.envelopeCharacterLimit { return AppBridgeDecodeResult.rejected(.oversized) }
        guard let envelope = jsonObject(raw) else { return AppBridgeDecodeResult.rejected(.malformed) }
        guard let versionNumber = number(envelope["v"]) else { return AppBridgeDecodeResult.rejected(.malformed) }
        let version = Int(versionNumber)
        guard let type = envelope["type"] as? String else { return AppBridgeDecodeResult.rejected(.malformed) }
        guard AppBridgeInboundType(rawValue: type) != nil else { return AppBridgeDecodeResult.rejected(.unknownType) }
        // A `ready` from another protocol version is reported (the card shows the version mismatch state); any other
        // message from another version is dropped.
        if version != AppBridgeProtocol.version && type != AppBridgeInboundType.ready.rawValue {
            return AppBridgeDecodeResult.rejected(.versionMismatch)
        }
        let callSessionId = envelope["callSessionId"] as? String ?? ""
        if callSessionId.isEmpty || callSessionId != expectation.callSessionId { return AppBridgeDecodeResult.rejected(.wrongCallSession) }
        let appSessionId = envelope["appSessionId"] as? String ?? ""
        if appSessionId.isEmpty || appSessionId != expectation.appSessionId { return AppBridgeDecodeResult.rejected(.staleAppSession) }
        let requestId = envelope["requestId"] as? String ?? ""
        if !isValidIdentifier(requestId) { return AppBridgeDecodeResult.rejected(.badRequestId) }
        var payload: [String: Any] = [:]
        if let value = envelope["payload"] {
            guard let dictionary = value as? [String: Any] else { return AppBridgeDecodeResult.rejected(.badPayload) }
            payload = dictionary
        }
        return decodePayload(type: type, requestId: requestId, version: version, payload: payload)
    }

    private static func decodePayload(type: String, requestId: String, version: Int, payload: [String: Any]) -> AppBridgeDecodeResult {
        switch AppBridgeInboundType(rawValue: type) ?? AppBridgeInboundType.resize {
        case .ready:
            let bundleVersion = payload["bundleVersion"] as? String ?? ""
            let appId = payload["appId"] as? String ?? ""
            if bundleVersion.isEmpty || bundleVersion.count > 32 || appId.isEmpty || appId.count > 128 {
                return AppBridgeDecodeResult.rejected(.badPayload)
            }
            let vector = bytes(payload["stateVector"], limit: AppBridgeProtocol.stateVectorByteLimit)
            if vector.rejection != AppBridgeRejection.none { return AppBridgeDecodeResult.rejected(vector.rejection) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, version: version, bundleVersion: bundleVersion,
                                                  appId: appId, bytes: vector.data))
        case .sync:
            let vector = bytes(payload["stateVector"], limit: AppBridgeProtocol.stateVectorByteLimit)
            if vector.rejection != AppBridgeRejection.none { return AppBridgeDecodeResult.rejected(vector.rejection) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, bytes: vector.data))
        case .update:
            let update = bytes(payload["update"], limit: AppBridgeProtocol.updateByteLimit)
            if update.rejection != AppBridgeRejection.none { return AppBridgeDecodeResult.rejected(update.rejection) }
            if update.data.isEmpty { return AppBridgeDecodeResult.rejected(.badPayload) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, bytes: update.data))
        case .awareness:
            let update = bytes(payload["update"], limit: AppBridgeProtocol.awarenessByteLimit)
            if update.rejection != AppBridgeRejection.none { return AppBridgeDecodeResult.rejected(update.rejection) }
            if update.data.isEmpty { return AppBridgeDecodeResult.rejected(.badPayload) }
            var clientId = -1
            if let value = number(payload["clientId"]) {
                if value < 0 || value > 4_294_967_295.0 { return AppBridgeDecodeResult.rejected(.badPayload) }
                clientId = Int(value)
            }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, bytes: update.data, clientId: clientId))
        case .status:
            guard let status = parseStatus(payload) else { return AppBridgeDecodeResult.rejected(.badPayload) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, status: status))
        case .ack:
            let ok = payload["ok"] as? Bool ?? false
            var error = payload["error"] as? String ?? ""
            if error.count > 64 { error = String(error.prefix(64)) }
            let png = payload["pngBase64"] as? String ?? ""
            if png.count > base64CharacterLimit(AppBridgeProtocol.exportByteLimit) { return AppBridgeDecodeResult.rejected(.payloadTooLarge) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, ok: ok, error: error, pngBase64: png))
        case .resize:
            let width = number(payload["width"]) ?? 0.0
            let height = number(payload["height"]) ?? 0.0
            if width < 0 || height < 0 || width > 100000 || height > 100000 { return AppBridgeDecodeResult.rejected(.badPayload) }
            return accepted(AppBridgeInbound.make(type: type, requestId: requestId, width: Int(width), height: Int(height)))
        }
    }

    private static func accepted(_ message: AppBridgeInbound) -> AppBridgeDecodeResult {
        return AppBridgeDecodeResult(rejection: AppBridgeRejection.none, message: message)
    }

    /// One outbound envelope as a JSON string, or "" when it cannot be encoded.
    static func encode(type: AppBridgeOutboundType, callSessionId: String, appSessionId: String, requestId: String,
                       payload: [String: Any]) -> String {
        let envelope: [String: Any] = [
            "v": AppBridgeProtocol.version,
            "type": type.rawValue,
            "callSessionId": callSessionId,
            "appSessionId": appSessionId,
            "requestId": requestId,
            "payload": payload,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: []) else { return "" }
        return String(data: data, encoding: String.Encoding.utf8) ?? ""
    }

    // MARK: Pieces (internal for tests)

    static func originMatches(_ origin: String, expected: String) -> Bool {
        if expected.isEmpty { return false }
        let actual = origin.lowercased()
        let wanted = expected.lowercased()
        return actual == wanted || actual == wanted + "/"
    }

    static func isValidIdentifier(_ value: String) -> Bool {
        if value.isEmpty || value.count > AppBridgeProtocol.identifierLimit { return false }
        for character in value {
            if !identifierCharacters.contains(character) { return false }
        }
        return true
    }

    static func isValidColor(_ value: String) -> Bool {
        if value == "transparent" { return true }
        if value.count != 7 || !value.hasPrefix("#") { return false }
        var index = 0
        for character in value {
            if index > 0 && !hexCharacters.contains(character) { return false }
            index += 1
        }
        return true
    }

    /// The largest base64 text for `bytes` decoded bytes (4 characters per 3 bytes, padded).
    static func base64CharacterLimit(_ bytes: Int) -> Int {
        return ((bytes + 2) / 3) * 4
    }

    /// Decodes an optional base64 field with a size bound checked before decoding. Missing means empty.
    static func bytes(_ value: Any?, limit: Int) -> AppBridgeBytes {
        guard let value = value else { return AppBridgeBytes(rejection: AppBridgeRejection.none, data: Data()) }
        guard let text = value as? String else { return AppBridgeBytes(rejection: AppBridgeRejection.badPayload, data: Data()) }
        if text.isEmpty { return AppBridgeBytes(rejection: AppBridgeRejection.none, data: Data()) }
        if text.count > base64CharacterLimit(limit) { return AppBridgeBytes(rejection: AppBridgeRejection.payloadTooLarge, data: Data()) }
        guard let data = Data(base64Encoded: text) else { return AppBridgeBytes(rejection: AppBridgeRejection.badPayload, data: Data()) }
        if data.count > limit { return AppBridgeBytes(rejection: AppBridgeRejection.payloadTooLarge, data: Data()) }
        return AppBridgeBytes(rejection: AppBridgeRejection.none, data: data)
    }

    /// The embed's status, bounded: an unknown tool or a malformed color rejects it; pages and names are clipped.
    static func parseStatus(_ payload: [String: Any]) -> AppEmbedStatus? {
        let tool = payload["tool"] as? String ?? AppWhiteboardTool.pen.rawValue
        if AppWhiteboardTool(rawValue: tool) == nil { return nil }
        let color = payload["color"] as? String ?? "#e3e3e8"
        if !isValidColor(color) { return nil }
        let width = Int(number(payload["strokeWidth"]) ?? 3)
        if width < 1 || width > 64 { return nil }
        let pageId = payload["pageId"] as? String ?? ""
        if !pageId.isEmpty && !isValidIdentifier(pageId) { return nil }
        var pages: [AppPageModel] = []
        if let rawPages = payload["pages"] as? [Any] {
            for rawPage in rawPages {
                if pages.count >= AppBridgeProtocol.pageLimit { break }
                guard let page = rawPage as? [String: Any] else { continue }
                let id = page["id"] as? String ?? ""
                if !isValidIdentifier(id) { continue }
                pages.append(AppPageModel(id: id, name: clipped(page["name"] as? String ?? "", AppBridgeProtocol.pageNameLimit),
                                          isCurrent: id == pageId))
            }
        }
        let elementCount = Int(number(payload["elementCount"]) ?? 0)
        let editorCount = Int(number(payload["editorCount"]) ?? 0)
        return AppEmbedStatus(tool: tool, color: color, strokeWidth: width, filled: payload["filled"] as? Bool ?? false,
                              canUndo: payload["canUndo"] as? Bool ?? false, canRedo: payload["canRedo"] as? Bool ?? false,
                              pageId: pageId, pageName: clipped(payload["pageName"] as? String ?? "", AppBridgeProtocol.pageNameLimit),
                              pages: pages, elementCount: max(0, min(elementCount, 1_000_000)),
                              editorCount: max(0, min(editorCount, 10_000)))
    }

    static func clipped(_ value: String, _ limit: Int) -> String {
        if value.count <= limit { return value }
        return String(value.prefix(limit))
    }

    static func jsonObject(_ raw: String) -> [String: Any]? {
        guard let data = raw.data(using: String.Encoding.utf8) else { return nil }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parsed as? [String: Any]
    }

    /// Numbers arrive as Int, Double or NSNumber depending on the platform reader (the GameProjectionJSON rule). No
    /// Bool check: on iOS an NSNumber 1 also casts to Bool, so such a check would refuse a valid version number.
    static func number(_ value: Any?) -> Double? {
        if let intValue = value as? Int { return Double(intValue) }
        if let doubleValue = value as? Double { return doubleValue }
        if let numberValue = value as? NSNumber { return numberValue.doubleValue }
        return nil
    }
}

/// A decoded binary field and why it was refused.
struct AppBridgeBytes: Equatable {
    let rejection: AppBridgeRejection
    let data: Data
}

/// S60 13 c: the Apple Pencil preferred actions (`UIPencilPreferredAction` raw values, UIPencilInteraction.h:20-41 in
/// the iPhoneOS 27.1 SDK) mapped to the native toolbar. Pure and shared so the mapping is unit tested without an iOS
/// availability check (cases 4 to 6 are iOS 16 and 17.5).
enum AppPencilResponse: String, CaseIterable, Equatable {
    case none, toggleEraser, previousTool, colorMenu, strokeMenu, toolPalette
}

enum AppPencilPolicy {
    static func response(rawAction: Int) -> AppPencilResponse {
        switch rawAction {
        case 1: return AppPencilResponse.toggleEraser
        case 2: return AppPencilResponse.previousTool
        case 3: return AppPencilResponse.colorMenu
        case 4: return AppPencilResponse.strokeMenu
        case 5: return AppPencilResponse.toolPalette
        default: return AppPencilResponse.none   // 0 ignore, 6 runSystemShortcut and anything newer
        }
    }
}
