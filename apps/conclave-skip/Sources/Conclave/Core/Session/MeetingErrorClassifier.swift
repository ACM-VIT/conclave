import Foundation

// WP2-S2a (S70 7, SX6, SY11; RECONCILE R48): one classifier turns every failure into a typed category. Each surface
// maps the category to its own copy (lobby S10 8, outcome S10 10, in-call toasts and banners S20 10, control rows S1C
// and S30 7, chat S40, host actions S50 PH16); raw text goes only to diagnostics. Pure and synchronous: no network and
// no localization work here. Everything crosses into handwritten Kotlin, so String raw-value enums and scalar structs.

enum MeetingErrorCategory: String, CaseIterable, Equatable {
    case offline, serverUnreachable, timedOut, serverBusy, serverRestarting, sessionExpired, notJoined
    case microphonePermission, cameraPermission, screenCapturePermission, deviceUnavailable, deviceInUse
    case rateLimited, roleRequired, lockedByHost, disabledByHost, attendeeOnly, invalidInput
    /// `platformRefused` (S70 revision 2): the OS refused (the Android foreground-service start), not the server.
    case roomNotFound, inviteCodeRequired, inviteCodeInvalid, signInRequired, roomEnded, rejectedByServer, platformRefused, cancelled, unknown
}

enum MeetingErrorContext: String, CaseIterable, Equatable {
    case join, rejoin, media, screenShare, chat, hostAction, browser, apps, game, transcript
}

/// The classifier's answer. `serverText` is kept only when it is a clean sentence a person can read (S10 8 rule),
/// otherwise empty; `diagnosticCode` is a stable ASCII code for logs; `retryAfterSeconds` is 0 when absent and is set
/// from the `Retry-After` header only for `serverBusy` and `serverRestarting` (RECONCILE R48, S10 0.8 C18).
struct ClassifiedError: Equatable {
    let category: MeetingErrorCategory
    let context: MeetingErrorContext
    let serverText: String
    let diagnosticCode: String
    let retryAfterSeconds: Int

    /// The precondition and cancel categories publish no feedback and show no failure message (S70 7 e, f).
    var isSilent: Bool {
        switch category {
        case .cancelled, .offline, .notJoined, .roleRequired, .lockedByHost, .disabledByHost, .attendeeOnly:
            return true
        default:
            return false
        }
    }
}

/// A non-2xx HTTP answer, typed so the classifier reads the status and the `Retry-After` header instead of English
/// text (S70 7 c order of evidence). `SfuJoinService` throws it for `POST /api/sfu/join` (HD request B2-T1).
struct MeetingHTTPStatusError: LocalizedError, Equatable {
    let statusCode: Int
    let retryAfterSeconds: Int
    let message: String

    var errorDescription: String? { message }
}

/// Which local device a media failure concerns, for the copy that names it.
enum MeetingMediaDevice: String, CaseIterable, Equatable {
    case none, microphone, camera, screen
}

enum MeetingErrorClassifier {
    /// The longest server sentence a surface may show as is.
    static let cleanTextLimit = 200

    /// Typed evidence first (HTTP status, URLError codes, the iOS socket and media errors, the Android exception
    /// classes), then today's substring tables (kept inside the classifier only). `isNetworkOffline` lets an
    /// unresolvable host read as `offline` while the reachability monitor reports no validated network (S70 7 d).
    static func classify(_ error: Error, context: MeetingErrorContext, isNetworkOffline: Bool = false) -> ClassifiedError {
        // SYS-10 (S70 10 f): screen share start failures carry their typed reason.
        if let shareError = error as? ScreenShareStartError {
            return typed(ScreenShareFailurePolicy.category(shareError.failure), context: context,
                         code: ScreenShareFailurePolicy.diagnosticCode(shareError.failure))
        }
        if let http = error as? MeetingHTTPStatusError {
            return classify(
                httpStatus: http.statusCode,
                retryAfterSeconds: http.retryAfterSeconds,
                serverMessage: http.message,
                context: context
            )
        }
        #if !SKIP
        if error is CancellationError {
            return typed(.cancelled, context: context, code: "task.cancelled")
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return typed(.offline, context: context, code: "url.offline")
            case .timedOut:
                return typed(.timedOut, context: context, code: "url.timedOut")
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return typed(isNetworkOffline ? .offline : .serverUnreachable, context: context, code: "url.unreachable")
            case .cancelled:
                return typed(.cancelled, context: context, code: "url.cancelled")
            case .userAuthenticationRequired:
                return typed(.sessionExpired, context: context, code: "url.auth")
            default:
                break
            }
        }
        #endif
        #if os(iOS) && !SKIP && canImport(SocketIO)
        if let socketError = error as? SocketError {
            switch socketError {
            case .notConnected:
                return typed(.serverUnreachable, context: context, code: "socket.notConnected")
            case .timeout:
                return typed(.timedOut, context: context, code: "socket.timeout")
            case .invalidURL:
                return typed(.serverUnreachable, context: context, code: "socket.invalidURL")
            case .connectionFailed:
                return typed(isNetworkOffline ? .offline : .serverUnreachable, context: context, code: "socket.connectionFailed")
            case .serverError(let message):
                return classify(serverMessage: message, context: context)
            }
        }
        #endif
        #if os(iOS) && !SKIP && canImport(WebRTC)
        if let mediaError = error as? WebRTCError {
            switch mediaError {
            case .permissionDenied:
                let category: MeetingErrorCategory = context == .screenShare ? .screenCapturePermission : .cameraPermission
                return typed(category, context: context, code: "media.permission")
            case .noCameraAvailable:
                return typed(.deviceUnavailable, context: context, code: "media.noCamera")
            case .notConfigured, .staleConfiguration, .noTransport:
                return typed(.serverUnreachable, context: context, code: "media.transport")
            case .connectionFailed:
                return typed(.serverUnreachable, context: context, code: "media.connectionFailed")
            }
        }
        #endif
        #if canImport(UIKit) && !SKIP
        if let captureError = error as? ScreenCaptureError {
            switch captureError {
            case .cancelled:
                return typed(.cancelled, context: context, code: "capture.cancelled")
            case .appGroupUnavailable:
                // S70 10 f notConfigured: "Couldn't start screen sharing. Try again.", not the camera sentence.
                return typed(.platformRefused, context: context, code: "capture.appGroup")
            case .socketUnavailable:
                return typed(.platformRefused, context: context, code: "capture.socket")
            }
        }
        #endif
        #if SKIP
        // Android media and transport failures are ErrorException(message) or Java exceptions; the classes are read
        // by the handwritten helper (the API 31 class is compared by name, so this code never names it).
        let androidCategory = MeetingAndroidErrorTypes.categoryName(error, isNetworkOffline)
        if !androidCategory.isEmpty, let category = MeetingErrorCategory(rawValue: androidCategory) {
            return typed(category, context: context, code: "android." + androidCategory)
        }
        #endif
        return classify(serverMessage: error.localizedDescription, context: context)
    }

    /// The substring tables of `MeetingMediaErrorPresentation`, `MeetingChatErrorPresentation`,
    /// `MeetingActionFailurePolicy` and the join form policy, in one ordered table (S70 7 c, CE H24, H37 to H47).
    static func classify(serverMessage: String, context: MeetingErrorContext) -> ClassifiedError {
        let trimmed = serverMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = trimmed.lowercased()
        let clean = cleanServerText(trimmed)
        if text.isEmpty {
            return ClassifiedError(category: .unknown, context: context, serverText: "", diagnosticCode: "message.empty", retryAfterSeconds: 0)
        }
        let row = messageRow(text, context: context)
        var category = row.category
        if category == .unknown && !clean.isEmpty {
            // A readable sentence from the server that no row recognizes is shown as is.
            category = .rejectedByServer
        }
        return ClassifiedError(category: category, context: context, serverText: clean, diagnosticCode: row.code, retryAfterSeconds: 0)
    }

    /// The HTTP rows (S70 7 c): 401 and 403 to `sessionExpired` or `signInRequired`, 429 to `rateLimited`, 503 during
    /// a drain to `serverRestarting`, other 5xx to `serverBusy`; a specific message row wins for other 4xx answers.
    static func classify(
        httpStatus: Int,
        retryAfterSeconds: Int,
        serverMessage: String,
        context: MeetingErrorContext
    ) -> ClassifiedError {
        let byMessage = classify(serverMessage: serverMessage, context: context)
        let specific = isSpecific(byMessage.category)
        var category = byMessage.category
        if httpStatus == 503 {
            category = byMessage.category == .serverRestarting ? .serverRestarting : .serverBusy
        } else if httpStatus >= 500 && httpStatus <= 599 {
            category = .serverBusy
        } else if httpStatus == 429 {
            category = .rateLimited
        } else if httpStatus == 401 {
            category = specific ? byMessage.category : .sessionExpired
        } else if httpStatus == 403 {
            if !specific && !(byMessage.category == .rejectedByServer && !byMessage.serverText.isEmpty) {
                category = .signInRequired
            }
        } else if httpStatus == 404 {
            category = specific ? byMessage.category : .roomNotFound
        }
        let retry = (category == .serverBusy || category == .serverRestarting) ? max(0, retryAfterSeconds) : 0
        return ClassifiedError(
            category: category,
            context: context,
            serverText: byMessage.serverText,
            diagnosticCode: "http." + String(httpStatus),
            retryAfterSeconds: retry
        )
    }

    /// `Retry-After` in delta seconds; the HTTP-date form and anything unreadable count as absent (0).
    static func retryAfterSeconds(header: String?) -> Int {
        guard let header else { return 0 }
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed), value > 0 else { return 0 }
        return value
    }

    /// The S1C row failure for a category (S70 7 j feeds `MeetingActionResult.failure`).
    static func actionFailure(_ error: ClassifiedError) -> MeetingActionFailure {
        if error.diagnosticCode == "socket.replaced" { return .socketReplaced }
        switch error.category {
        case .offline, .serverUnreachable:
            return .notConnected
        case .timedOut:
            return .ackTimedOut
        case .notJoined:
            return .notJoined
        case .microphonePermission, .cameraPermission, .screenCapturePermission:
            return .permissionDenied
        case .deviceUnavailable, .deviceInUse:
            return .deviceUnavailable
        case .roleRequired, .attendeeOnly:
            return .roleRequired
        case .unknown, .cancelled:
            return .unknown
        case .serverBusy, .serverRestarting, .sessionExpired, .rateLimited, .lockedByHost, .disabledByHost,
             .invalidInput, .roomNotFound, .inviteCodeRequired, .inviteCodeInvalid, .signInRequired, .roomEnded,
             .rejectedByServer, .platformRefused:
            return .rejectedByServer
        }
    }

    /// A ticket result: `cancelled` for a cancel, else a failure carrying only clean server text.
    static func actionResult(_ error: ClassifiedError, direction: MeetingActionDirection = .none) -> MeetingActionResult {
        if error.category == .cancelled {
            return MeetingActionResult(kind: .cancelled, failure: .none, serverText: nil, direction: direction)
        }
        return MeetingActionResult.failed(
            actionFailure(error),
            serverText: error.serverText.isEmpty ? nil : error.serverText,
            direction: direction
        )
    }

    /// The S10 8 rule: a sentence a person can read, never protocol noise.
    static func cleanServerText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= cleanTextLimit else { return "" }
        let lowered = trimmed.lowercased()
        for noise in noiseFragments {
            if lowered.contains(noise) { return "" }
        }
        // A sentence has letters: digits and punctuation read the same in both cases.
        return lowered != trimmed.uppercased() ? trimmed : ""
    }

    private static let noiseFragments: [String] = [
        "xhr", "websocket", "socket", "sfu", "acknowledgement", "acknowledgment", "transport", "throwable",
        "exception", "error:", "failed to toggle", "producer", "consumer", "webrtc", "timed out", "timeout",
        "http", "://", "null", "undefined", "{", "}", "request failed", "errordomain", "nsurl",
    ]

    private static func isSpecific(_ category: MeetingErrorCategory) -> Bool {
        switch category {
        case .unknown, .rejectedByServer, .serverUnreachable, .timedOut:
            return false
        default:
            return true
        }
    }

    private static func typed(_ category: MeetingErrorCategory, context: MeetingErrorContext, code: String) -> ClassifiedError {
        ClassifiedError(category: category, context: context, serverText: "", diagnosticCode: code, retryAfterSeconds: 0)
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        for needle in needles {
            if text.contains(needle) { return true }
        }
        return false
    }

    /// One ordered table; the first matching row wins.
    private static func messageRow(_ text: String, context: MeetingErrorContext) -> MeetingErrorRow {
        if containsAny(text, ["cancelled", "canceled"]) {
            return MeetingErrorRow(category: .cancelled, code: "message.cancelled")
        }
        if text.contains("socket changed before") {
            return MeetingErrorRow(category: .serverUnreachable, code: "socket.replaced")
        }
        if containsAny(text, ["timed out", "timeout"]) {
            return MeetingErrorRow(category: .timedOut, code: "message.timedOut")
        }
        if containsAny(text, ["not connected to the internet", "network is unreachable", "no internet", "you're offline", "you are offline"]) {
            return MeetingErrorRow(category: .offline, code: "message.offline")
        }
        if containsAny(text, ["draining", "restarting"]) {
            return MeetingErrorRow(category: .serverRestarting, code: "message.serverRestarting")
        }
        if containsAny(text, ["temporarily unavailable", "try again shortly", "server busy", "hosted by another sfu"]) {
            return MeetingErrorRow(category: .serverBusy, code: "message.serverBusy")
        }
        if containsAny(text, ["has been ended", "meeting has ended", "ended by the host", "room has ended", "meeting ended"]) {
            return MeetingErrorRow(category: .roomEnded, code: "message.roomEnded")
        }
        if containsAny(text, ["no room found", "room not found", "meeting not found"]) {
            return MeetingErrorRow(category: .roomNotFound, code: "message.roomNotFound")
        }
        if containsAny(text, ["invalid meeting invite code", "invalid webinar invite code", "invalid invite code"]) {
            return MeetingErrorRow(category: .inviteCodeInvalid, code: "message.inviteCodeInvalid")
        }
        if containsAny(text, ["invite code required"]) {
            return MeetingErrorRow(category: .inviteCodeRequired, code: "message.inviteCodeRequired")
        }
        if containsAny(text, ["guests are not allowed", "sign in to join", "sign-in required", "sign in required"]) {
            return MeetingErrorRow(category: .signInRequired, code: "message.signInRequired")
        }
        if containsAny(text, ["session expired", "token expired", "authentication error", "sign in again"]) {
            return MeetingErrorRow(category: .sessionExpired, code: "message.sessionExpired")
        }
        if containsAny(text, ["rate limit", "too quickly", "too many", "slow down"]) {
            return MeetingErrorRow(category: .rateLimited, code: "message.rateLimited")
        }
        if containsAny(text, ["only the host", "only hosts", "not authorized", "unauthorized", "admin only", "host only", "not an admin"]) {
            return MeetingErrorRow(category: .roleRequired, code: "message.roleRequired")
        }
        if containsAny(text, ["disabled by the host", "disabled by host", "turned off by the host", "are disabled"]) {
            return MeetingErrorRow(category: .disabledByHost, code: "message.disabledByHost")
        }
        if text.contains("locked") {
            return MeetingErrorRow(category: .lockedByHost, code: "message.locked")
        }
        if containsAny(text, ["use the public webinar link", "attendees cannot", "as an attendee"]) {
            return MeetingErrorRow(category: .attendeeOnly, code: "message.attendeeOnly")
        }
        let mediaContext = context == .media || context == .screenShare
        if containsAny(text, ["permission", "notallowederror", "not granted", "access denied"])
            || (mediaContext && text.contains("denied")) {
            if context == .screenShare || text.contains("screen") {
                return MeetingErrorRow(category: .screenCapturePermission, code: "message.permission")
            }
            if text.contains("camera") {
                return MeetingErrorRow(category: .cameraPermission, code: "message.permission")
            }
            return MeetingErrorRow(category: .microphonePermission, code: "message.permission")
        }
        if containsAny(text, ["in use", "being used by another", "device busy"]) {
            return MeetingErrorRow(category: .deviceInUse, code: "message.deviceInUse")
        }
        if containsAny(text, [
            "notfounderror", "devicesnotfounderror", "camera available", "no camera", "no microphone", "no video track",
            "no audio track", "device unavailable", "source unavailable", "unavailable on this device",
        ]) {
            return MeetingErrorRow(category: .deviceUnavailable, code: "message.deviceUnavailable")
        }
        if containsAny(text, ["not in a room", "not in room", "not joined", "join a room first"]) {
            return MeetingErrorRow(category: .notJoined, code: "message.notJoined")
        }
        if containsAny(text, ["not connected", "socket disconnected", "connection", "socket", "transport", "failed to connect", "network"]) {
            return MeetingErrorRow(category: .serverUnreachable, code: "socket.notConnected")
        }
        if containsAny(text, ["invalid", "missing", "too long"]) {
            return MeetingErrorRow(category: .invalidInput, code: "message.invalidInput")
        }
        return MeetingErrorRow(category: .unknown, code: "message.unrecognized")
    }
}

/// One table row: a category and its diagnostic code.
struct MeetingErrorRow: Equatable {
    let category: MeetingErrorCategory
    let code: String
}

/// The one automatic join retry of S10 0.8 C18 (RECONCILE R48), for the S10 join coordinator: retry once after
/// `min(Retry-After, 10)` s for `serverBusy` and `serverRestarting`, then show the failed block. Without a
/// `Retry-After` value there is no automatic retry.
enum MeetingJoinRetryPolicy {
    static let maxDelaySeconds = 10

    static func automaticRetryDelaySeconds(_ error: ClassifiedError, retriesSoFar: Int) -> Int? {
        guard retriesSoFar == 0 else { return nil }
        guard error.category == .serverBusy || error.category == .serverRestarting else { return nil }
        guard error.retryAfterSeconds > 0 else { return nil }
        return min(error.retryAfterSeconds, maxDelaySeconds)
    }
}

/// English copy for the legacy `errorMessage` banner only (legacy surfaces are not localized). Native surfaces never
/// read it: they map the category to their own catalog keys (S70 7 g). Uses the S70 7 g and S20 10 g sentences, so no
/// raw transport text reaches the legacy banner either. Returns nil when nothing should show (cancel).
enum MeetingErrorLegacyCopy {
    static let genericFailure = "That didn't go through. Try again."

    static func message(_ error: ClassifiedError, device: MeetingMediaDevice = .none) -> String? {
        if error.context == .chat {
            return chatMessage(error)
        }
        if error.context == .join || error.context == .rejoin {
            return joinMessage(error)
        }
        switch error.category {
        case .cancelled:
            return nil
        case .offline:
            return "You're offline. Waiting for a connection."
        case .sessionExpired:
            return "Your sign-in expired. Sign in again after the call."
        case .microphonePermission:
            return "Microphone access is off. Turn it on in Settings."
        case .cameraPermission:
            return "Camera access is off. Turn it on in Settings."
        case .screenCapturePermission:
            return "Screen sharing isn't allowed on this device."
        case .deviceUnavailable:
            return device == .microphone
                ? "Your microphone isn't available right now."
                : "Your camera isn't available right now."
        case .deviceInUse:
            return device == .microphone
                ? "Your microphone isn't available right now."
                : "Another app is using your camera."
        case .platformRefused:
            return error.context == .screenShare ? "Couldn't start screen sharing. Try again." : genericFailure
        case .serverUnreachable, .timedOut, .serverBusy, .serverRestarting, .unknown:
            return genericFailure
        case .notJoined, .rateLimited, .roleRequired, .lockedByHost, .disabledByHost, .attendeeOnly, .invalidInput,
             .roomNotFound, .inviteCodeRequired, .inviteCodeInvalid, .signInRequired, .roomEnded, .rejectedByServer:
            return error.serverText.isEmpty ? genericFailure : error.serverText
        }
    }

    /// The S10 8 f failed-block bodies for the legacy join error screen.
    private static func joinMessage(_ error: ClassifiedError) -> String? {
        switch error.category {
        case .cancelled:
            return nil
        case .offline:
            return "You're offline. Waiting for a connection."
        case .serverUnreachable, .timedOut:
            return "We couldn't reach Conclave. Check your connection and try again."
        case .serverBusy, .serverRestarting:
            return "The meeting server is restarting. Try again in a moment."
        case .microphonePermission, .cameraPermission, .screenCapturePermission, .deviceUnavailable, .deviceInUse,
             .platformRefused:
            return "The media connection didn't go through. Try again."
        case .unknown:
            return "Something went wrong while joining. Try again."
        default:
            return error.serverText.isEmpty ? "Something went wrong while joining. Try again." : error.serverText
        }
    }

    /// The chat send copy kept from the retired chat presentation enum.
    private static func chatMessage(_ error: ClassifiedError) -> String? {
        switch error.category {
        case .cancelled:
            return nil
        case .offline, .serverUnreachable, .timedOut, .notJoined:
            return "Reconnect before sending chat."
        default:
            return error.serverText.isEmpty ? "Could not send chat." : error.serverText
        }
    }
}
