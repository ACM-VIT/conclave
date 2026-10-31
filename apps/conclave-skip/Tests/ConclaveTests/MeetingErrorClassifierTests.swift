#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct MeetingErrorClassifierTests {

    static let messageRows: [(String, MeetingErrorContext, MeetingErrorCategory)] = [
        ("Socket is not connected", .chat, .serverUnreachable),
        ("Socket not connected", .hostAction, .serverUnreachable),
        ("Timed out waiting for the SFU", .hostAction, .timedOut),
        ("Timed out waiting for setHandRaised acknowledgement", .hostAction, .timedOut),
        ("Socket changed before setHandRaised acknowledgement", .hostAction, .serverUnreachable),
        ("Connection error", .join, .serverUnreachable),
        ("Timed out waiting for SFU connection", .join, .timedOut),
        ("Microphone permission not granted", .media, .microphonePermission),
        ("Camera permission not granted", .media, .cameraPermission),
        ("Camera/microphone permission denied", .media, .cameraPermission),
        ("NotAllowedError", .media, .microphonePermission),
        ("No screen capture permission", .screenShare, .screenCapturePermission),
        ("Screen source unavailable", .screenShare, .deviceUnavailable),
        ("Send transport not ready", .media, .mediaSessionStale),
        ("Transport not created", .media, .mediaSessionStale),
        ("Send transport not ready", .join, .serverUnreachable),
        ("Transport not created", .hostAction, .serverUnreachable),
        ("WebRTC client not configured", .media, .mediaSessionStale),
        ("WebRTC session was replaced", .media, .mediaSessionStale),
        ("Socket not configured", .media, .mediaSessionStale),
        ("Device not configured", .media, .mediaSessionStale),
        ("User not found in waiting room", .hostAction, .pendingUserNotFound),
        ("Consumer not found", .media, .consumerNotFound),
        ("Consumer not found", .hostAction, .unknown),
        ("No camera available", .media, .deviceUnavailable),
        ("No rear camera available", .media, .deviceUnavailable),
        ("DevicesNotFoundError", .media, .deviceUnavailable),
        ("The camera is in use by another app", .media, .deviceInUse),
        ("This meeting has been ended by the host.", .rejoin, .roomEnded),
        ("No room found.", .join, .roomNotFound),
        ("Meeting invite code required.", .join, .inviteCodeRequired),
        ("Invalid meeting invite code.", .join, .inviteCodeInvalid),
        ("Webinar invite code required.", .join, .inviteCodeRequired),
        ("Invalid webinar invite code.", .join, .inviteCodeInvalid),
        ("Guests are not allowed in this meeting.", .join, .signInRequired),
        ("Meeting server is draining. Try again shortly.", .join, .serverRestarting),
        ("Meeting servers are draining. Try again shortly.", .join, .serverRestarting),
        ("Meeting placement is temporarily unavailable. Try again shortly.", .join, .serverBusy),
        ("Room is hosted by another SFU instance.", .join, .serverBusy),
        ("Webinar is locked.", .join, .lockedByHost),
        ("Room is locked", .hostAction, .lockedByHost),
        ("Use the public webinar link to join as an attendee.", .join, .attendeeOnly),
        ("Display name too long", .hostAction, .invalidInput),
        ("You are changing your display name too quickly", .hostAction, .rateLimited),
        ("Display name updates are disabled", .hostAction, .disabledByHost),
        ("Only the host can end the meeting", .hostAction, .roleRequired),
        ("Webinar is full.", .join, .rejectedByServer),
        ("Webinar is not live.", .join, .rejectedByServer),
        ("You are not allowed to join this meeting.", .join, .rejectedByServer),
        ("Authentication error: Invalid token payload", .join, .sessionExpired),
        ("The operation was cancelled.", .screenShare, .cancelled),
        ("Missing room ID", .join, .invalidInput),
        ("You are not in a room", .hostAction, .notJoined),
        ("", .media, .unknown),
        ("   ", .hostAction, .unknown),
        ("Screen sharing failed to start: java.lang.SecurityException: denied", .apps, .unknown),
    ]

    @Test func messageTableMapsEveryKnownRawString() {
        for (text, context, expected) in Self.messageRows {
            let classified = MeetingErrorClassifier.classify(serverMessage: text, context: context)
            #expect(classified.category == expected, "\(text) in \(context): \(classified.category)")
            #expect(classified.context == context)
            #expect(classified.retryAfterSeconds == 0)
            #expect(!classified.diagnosticCode.isEmpty)
        }
        #expect(MeetingErrorClassifier.classify(serverMessage: "Socket changed before setHandRaised acknowledgement", context: .hostAction).diagnosticCode == "socket.replaced")
    }

    @Test func onlyCleanSentencesSurviveAsServerText() {
        #expect(MeetingErrorClassifier.classify(serverMessage: "Room is locked", context: .hostAction).serverText == "Room is locked")
        #expect(MeetingErrorClassifier.classify(serverMessage: "Webinar is full.", context: .join).serverText == "Webinar is full.")
        for noisy in [
            "Socket is not connected", "Timed out waiting for setHandRaised acknowledgement", "Send transport not ready",
            "Room is hosted by another SFU instance.", "Failed to toggle screen sharing: denied", "xhr poll error",
            "websocket error", "java.lang.IllegalStateException", "Join request failed", "12345", "",
            String(repeating: "a", count: 201),
        ] {
            #expect(MeetingErrorClassifier.cleanServerText(noisy).isEmpty, "\(noisy) leaked")
        }
    }

    @Test func httpRowsAndRetryAfter() {

        let draining = MeetingErrorClassifier.classify(httpStatus: 503, retryAfterSeconds: 5, serverMessage: "Meeting servers are draining. Try again shortly.", context: .join)
        #expect(draining.category == .serverRestarting)
        #expect(draining.retryAfterSeconds == 5)
        #expect(draining.diagnosticCode == "http.503")
        let placement = MeetingErrorClassifier.classify(httpStatus: 503, retryAfterSeconds: 2, serverMessage: "Meeting placement is temporarily unavailable. Try again shortly.", context: .join)
        #expect(placement.category == .serverBusy)
        #expect(placement.retryAfterSeconds == 2)
        #expect(MeetingErrorClassifier.classify(httpStatus: 500, retryAfterSeconds: 0, serverMessage: "", context: .join).category == .serverBusy)
        let limited = MeetingErrorClassifier.classify(httpStatus: 429, retryAfterSeconds: 9, serverMessage: "", context: .join)
        #expect(limited.category == .rateLimited)
        #expect(limited.retryAfterSeconds == 0, "Retry-After is kept only for serverBusy and serverRestarting")
        #expect(MeetingErrorClassifier.classify(httpStatus: 401, retryAfterSeconds: 0, serverMessage: "", context: .join).category == .sessionExpired)
        #expect(MeetingErrorClassifier.classify(httpStatus: 403, retryAfterSeconds: 0, serverMessage: "", context: .join).category == .signInRequired)
        #expect(MeetingErrorClassifier.classify(httpStatus: 403, retryAfterSeconds: 0, serverMessage: "You are not allowed to join this meeting.", context: .join).category == .rejectedByServer)
        #expect(MeetingErrorClassifier.classify(httpStatus: 403, retryAfterSeconds: 0, serverMessage: "Guests are not allowed in this meeting.", context: .join).category == .signInRequired)
        #expect(MeetingErrorClassifier.classify(httpStatus: 404, retryAfterSeconds: 0, serverMessage: "", context: .join).category == .roomNotFound)
        #expect(MeetingErrorClassifier.classify(httpStatus: 400, retryAfterSeconds: 0, serverMessage: "Missing room ID", context: .join).category == .invalidInput)

        let typed = MeetingErrorClassifier.classify(MeetingHTTPStatusError(statusCode: 503, retryAfterSeconds: 2, message: "Meeting placement is temporarily unavailable. Try again shortly."), context: .join)
        #expect(typed == placement)
        #expect(MeetingErrorClassifier.retryAfterSeconds(header: "5") == 5)
        #expect(MeetingErrorClassifier.retryAfterSeconds(header: " 2 ") == 2)
        #expect(MeetingErrorClassifier.retryAfterSeconds(header: "Wed, 21 Oct 2015 07:28:00 GMT") == 0)
        #expect(MeetingErrorClassifier.retryAfterSeconds(header: "-1") == 0)
        #expect(MeetingErrorClassifier.retryAfterSeconds(header: nil) == 0)
    }

    @Test func oneAutomaticJoinRetryAfterRetryAfter() {

        func error(_ category: MeetingErrorCategory, _ retry: Int) -> ClassifiedError {
            ClassifiedError(category: category, context: .join, serverText: "", diagnosticCode: "http.503", retryAfterSeconds: retry)
        }
        #expect(MeetingJoinRetryPolicy.automaticRetryDelaySeconds(error(.serverBusy, 2), retriesSoFar: 0) == 2)
        #expect(MeetingJoinRetryPolicy.automaticRetryDelaySeconds(error(.serverRestarting, 30), retriesSoFar: 0) == 10)
        #expect(MeetingJoinRetryPolicy.automaticRetryDelaySeconds(error(.serverBusy, 2), retriesSoFar: 1) == nil)
        #expect(MeetingJoinRetryPolicy.automaticRetryDelaySeconds(error(.serverBusy, 0), retriesSoFar: 0) == nil)
        #expect(MeetingJoinRetryPolicy.automaticRetryDelaySeconds(error(.timedOut, 5), retriesSoFar: 0) == nil)
    }

    @Test func urlErrorCodesAreTyped() {

        func category(_ code: URLError.Code, offline: Bool = false) -> MeetingErrorCategory {
            MeetingErrorClassifier.classify(URLError(code), context: .join, isNetworkOffline: offline).category
        }
        #expect(category(.notConnectedToInternet) == .offline)
        #expect(category(.timedOut) == .timedOut)
        #expect(category(.cannotFindHost) == .serverUnreachable)
        #expect(category(.cannotConnectToHost) == .serverUnreachable)
        #expect(category(.cannotFindHost, offline: true) == .offline)
        #expect(category(.cancelled) == .cancelled)
        #expect(MeetingErrorClassifier.classify(CancellationError(), context: .media).category == .cancelled)
    }

    @Test func everyCategoryMapsToOneRowFailure() {
        let expected: [MeetingErrorCategory: MeetingActionFailure] = [
            .offline: .notConnected, .serverUnreachable: .notConnected, .timedOut: .ackTimedOut, .notJoined: .notJoined,
            .microphonePermission: .permissionDenied, .cameraPermission: .permissionDenied,
            .screenCapturePermission: .permissionDenied, .deviceUnavailable: .deviceUnavailable,
            .deviceInUse: .deviceUnavailable, .roleRequired: .roleRequired, .attendeeOnly: .roleRequired,
            .unknown: .unknown, .cancelled: .unknown, .mediaSessionStale: .notConnected, .consumerNotFound: .unknown,
        ]
        for category in MeetingErrorCategory.allCases {
            let error = ClassifiedError(category: category, context: .hostAction, serverText: "", diagnosticCode: "test", retryAfterSeconds: 0)
            #expect(MeetingErrorClassifier.actionFailure(error) == (expected[category] ?? .rejectedByServer), "\(category)")
        }
        let replaced = ClassifiedError(category: .serverUnreachable, context: .hostAction, serverText: "", diagnosticCode: "socket.replaced", retryAfterSeconds: 0)
        #expect(MeetingErrorClassifier.actionFailure(replaced) == .socketReplaced)
        let cancelled = ClassifiedError(category: .cancelled, context: .hostAction, serverText: "", diagnosticCode: "test", retryAfterSeconds: 0)
        #expect(MeetingErrorClassifier.actionResult(cancelled) == MeetingActionResult.cancelled)
        let lowered = MeetingErrorClassifier.actionResult(
            MeetingErrorClassifier.classify(serverMessage: "Room is locked", context: .hostAction),
            direction: .lower
        )
        #expect(lowered == MeetingActionResult.failed(.rejectedByServer, serverText: "Room is locked", direction: .lower))
    }

    @Test func noRawTransportTextReachesTheLegacyBanner() {

        let forbidden = ["sfu", "socket", "acknowledgement", "transport", "throwable", "failed to toggle", "exception"]
        for category in MeetingErrorCategory.allCases {
            for context in MeetingErrorContext.allCases {
                for device in MeetingMediaDevice.allCases {
                    let error = ClassifiedError(category: category, context: context, serverText: "", diagnosticCode: "test", retryAfterSeconds: 0)
                    guard let message = MeetingErrorLegacyCopy.message(error, device: device) else {
                        #expect(category == .cancelled, "\(category) in \(context) shows nothing")
                        continue
                    }
                    #expect(!message.isEmpty)
                    for fragment in forbidden {
                        #expect(!message.lowercased().contains(fragment), "\(category) in \(context): \(message)")
                    }
                    #expect(!message.contains("\u{2013}") && !message.contains("\u{2014}"))
                }
            }
        }

        for (text, context, _) in Self.messageRows {
            let classified = MeetingErrorClassifier.classify(serverMessage: text, context: context)
            if let message = MeetingErrorLegacyCopy.message(classified) {
                for fragment in forbidden {
                    #expect(!message.lowercased().contains(fragment), "\(text) became \(message)")
                }
            }
        }
        let chat = MeetingErrorClassifier.classify(serverMessage: "Socket is not connected", context: .chat)
        #expect(MeetingErrorLegacyCopy.message(chat) == "Reconnect before sending chat.")
        let locked = MeetingErrorClassifier.classify(serverMessage: "Chat is locked by the host.", context: .chat)
        #expect(MeetingErrorLegacyCopy.message(locked) == "Chat is locked by the host.")
        let camera = MeetingErrorClassifier.classify(serverMessage: "No camera available", context: .media)
        #expect(MeetingErrorLegacyCopy.message(camera, device: .camera) == "Your camera isn't available right now.")
        let mic = MeetingErrorClassifier.classify(serverMessage: "Microphone permission not granted", context: .media)
        #expect(MeetingErrorLegacyCopy.message(mic, device: .microphone) == "Microphone access is off. Turn it on in Settings.")
        let join = MeetingErrorClassifier.classify(serverMessage: "Socket is not connected", context: .join)
        #expect(MeetingErrorLegacyCopy.message(join) == "We couldn't reach Conclave. Check your connection and try again.")
        let full = MeetingErrorClassifier.classify(serverMessage: "Webinar is full.", context: .join)
        #expect(MeetingErrorLegacyCopy.message(full) == "Webinar is full.")
        let unknown = MeetingErrorClassifier.classify(serverMessage: "Join request failed", context: .join)
        #expect(MeetingErrorLegacyCopy.message(unknown) == "Something went wrong while joining. Try again.")
        let media = MeetingErrorClassifier.classify(serverMessage: "Send transport not ready", context: .media)
        #expect(MeetingErrorLegacyCopy.message(media) == MeetingErrorLegacyCopy.genericFailure)
    }

    @Test func theClassifierReplacedThePresentationEnums() throws {
        let vm = try classifierSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        for gone in ["enum MeetingMediaErrorPresentation", "enum MeetingChatErrorPresentation",
                     "MeetingMediaErrorPresentation.", "MeetingChatErrorPresentation.",
                     "state.errorMessage = error.localizedDescription"] {
            #expect(!vm.contains(gone), "\(gone) is still in the view model")
        }

        #expect(vm.contains("await self.finishServerDisconnect()"))
        #expect(vm.contains("recordTerminalOutcome(.serverDisconnected, serverText: \"\")\n        state.connectionState = ConnectionState.disconnected"))
        #expect(vm.contains("if classified.category == .roomEnded {"))
        #expect(vm.contains("outcome: .endedByHost\n                        )"))

        let classifier = try classifierSource("Sources/Conclave/Core/Session/MeetingErrorClassifier.swift")
        for pattern in ["ConclaveStrings", "NSLocalizedString", "URLSession", "Task {", "\u{2013}", "\u{2014}"] {
            #expect(!classifier.contains(pattern), "\(pattern)")
        }
        #expect(classifier.contains("#if os(iOS) && !SKIP && canImport(SocketIO)\n        if let socketError = error as? SocketError {"))
        #expect(classifier.contains("#if os(iOS) && !SKIP && canImport(WebRTC)\n        if let mediaError = error as? WebRTCError {"))
        #expect(classifier.contains("#if canImport(UIKit) && !SKIP\n        if let captureError = error as? ScreenCaptureError {"))
        #expect(classifier.contains("let androidCategory = MeetingAndroidErrorTypes.categoryName(error, isNetworkOffline)"))
        let android = try classifierSource("Sources/Conclave/Skip/ui/session/MeetingAndroidErrorTypes.kt")
        #expect(android.contains("if (sdkInt >= 31 && className == FOREGROUND_SERVICE_NOT_ALLOWED) \"platformRefused\" else \"\""))
        #expect(!android.contains("import android.app.ForegroundServiceStartNotAllowedException"))
    }

    @Test func recoveryCategoriesAreAddedWithoutRenamingAnyPersistedRawValue() {
        let persisted = [
            "offline", "serverUnreachable", "timedOut", "serverBusy", "serverRestarting", "sessionExpired", "notJoined",
            "microphonePermission", "cameraPermission", "screenCapturePermission", "deviceUnavailable", "deviceInUse",
            "rateLimited", "roleRequired", "lockedByHost", "disabledByHost", "attendeeOnly", "invalidInput",
            "roomNotFound", "inviteCodeRequired", "inviteCodeInvalid", "signInRequired", "roomEnded", "rejectedByServer",
            "platformRefused", "cancelled", "unknown",
        ]
        for raw in persisted {
            #expect(MeetingErrorCategory(rawValue: raw) != nil, "\(raw) was renamed or removed")
        }
        #expect(MeetingErrorCategory.mediaSessionStale.rawValue == "mediaSessionStale")
        #expect(MeetingErrorCategory.pendingUserNotFound.rawValue == "pendingUserNotFound")
        #expect(MeetingErrorCategory.consumerNotFound.rawValue == "consumerNotFound")
        #expect(MeetingErrorCategory.allCases.count == persisted.count + 3)

        let stale = MeetingErrorClassifier.classify(serverMessage: "Send transport not ready", context: .media)
        #expect(stale.diagnosticCode == "message.mediaSessionStale")
        #expect(!stale.isSilent)
        #expect(MeetingErrorClassifier.actionFailure(stale) == .notConnected)
        #expect(MeetingErrorLegacyCopy.message(stale, device: .microphone) == MeetingErrorLegacyCopy.genericFailure)

        let pending = MeetingErrorClassifier.classify(serverMessage: "User not found in waiting room", context: .hostAction)
        #expect(pending.diagnosticCode == "message.pendingUserNotFound")
        #expect(pending.serverText == "User not found in waiting room")
        #expect(MeetingErrorClassifier.actionFailure(pending) == .rejectedByServer)
        #expect(MeetingErrorLegacyCopy.message(pending) == "User not found in waiting room")
        #expect(HostActionFailurePolicy.failure(message: "User not found in waiting room") == .notFound)

        let consumer = MeetingErrorClassifier.classify(serverMessage: "Consumer not found", context: .media)
        #expect(consumer.diagnosticCode == "message.consumerNotFound")
        #expect(consumer.serverText.isEmpty)
        #expect(MeetingErrorClassifier.actionFailure(consumer) == .unknown)
        #expect(MeetingErrorLegacyCopy.message(consumer) == MeetingErrorLegacyCopy.genericFailure)
        #expect(MeetingErrorClassifier.classify(serverMessage: "{\"error\":\"x\",\"code\":\"not_found\"}", context: .media).category == .consumerNotFound)

        #expect(MeetingErrorClassifier.classify(httpStatus: 404, retryAfterSeconds: 0, serverMessage: "Consumer not found", context: .media).category == .roomNotFound)
        #expect(MeetingErrorClassifier.classify(httpStatus: 401, retryAfterSeconds: 0, serverMessage: "Socket not configured", context: .media).category == .sessionExpired)

        let wrapped = NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "WebRTC session was replaced"])
        #expect(MeetingErrorClassifier.classify(wrapped, context: .media).category == .mediaSessionStale)
        #expect(MeetingErrorClassifier.classify(wrapped, context: .screenShare).category != .mediaSessionStale)
        let socket = NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "Socket is not connected"])
        #expect(MeetingErrorClassifier.classify(socket, context: .media).category == .serverUnreachable)
        let cancelled = NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "StandaloneCoroutine was cancelled"])
        #expect(MeetingErrorClassifier.classify(cancelled, context: .media).category == .cancelled)
    }

    @Test func recoveryDecisionsReadCategoriesNotWording() throws {
        let vm = try classifierSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let rejoin = try classifierBody(vm, from: "private func shouldForceRejoinAfterAudioPublishingFailure(_ error: Error) -> Bool {",
                                        to: "private func toggleMuteIntentDuringRecovery() {")
        #expect(rejoin.contains("MeetingErrorClassifier.classify(error, context: .media, isNetworkOffline: state.isNetworkOffline)"))
        #expect(rejoin.contains("return classified.category == .mediaSessionStale"))
        let waiting = try classifierBody(vm, from: "private func removeStalePendingUserIfNeeded(",
                                         to: "private func ensureParticipantPresent(")
        #expect(waiting.contains("MeetingErrorClassifier.classify(error, context: .hostAction, isNetworkOffline: state.isNetworkOffline)"))
        #expect(waiting.contains("guard classified.category == .pendingUserNotFound else {"))
        for site in [rejoin, waiting] {
            #expect(!site.contains(".contains("))
            #expect(!site.contains("localizedDescription"))
            #expect(!site.contains("lowercased()"))
            #expect(!site.contains("\""))
        }
        for gone in ["\"not found in waiting room\"", "\"stale configuration\"", "\"socket not configured\"", "transportFailures"] {
            #expect(!vm.contains(gone), "\(gone) is still in the view model")
        }

        let ios = try classifierSource("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let iosClose = try classifierBody(ios, from: "func closeConsumerAndWait(", to: "func setConsumerPreferences(")
        #expect(iosClose.contains("if MeetingErrorClassifier.classify(error, context: .media).category == .consumerNotFound {"))
        let android = try classifierSource("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        let androidClose = try classifierBody(android, from: "internal suspend fun closeConsumerAndWait(",
                                              to: "internal suspend fun setConsumerPreferences(")
        #expect(androidClose.contains("MeetingErrorClassifier.classify(serverMessage = message, context = MeetingErrorContext.media)"))
        #expect(androidClose.contains("if (classified.category == MeetingErrorCategory.consumerNotFound) {"))
        for site in [iosClose, androidClose] {
            #expect(!site.contains("not found"))
            #expect(!site.contains("not_found"))
            #expect(!site.contains(".contains("))
            #expect(!site.contains("lowercase"))
        }

        let classifier = try classifierSource("Sources/Conclave/Core/Session/MeetingErrorClassifier.swift")
        for fragment in ["\"not configured\"", "\"transport not created\"", "\"send transport\"", "\"stale configuration\"",
                         "\"session was replaced\"", "\"socket not configured\"", "\"consumer not found\"", "\"not_found\"",
                         "\"not found in waiting room\""] {
            #expect(classifier.contains(fragment), "\(fragment) left the classifier table")
        }
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct MeetingErrorClassifierViewModelTests {
    @Test func serverDisconnectIsRecordedOnceWithTheConnectionLostToken() async {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: "room-a",
            displayName: "Avery",
            socketDisplayName: nil,
            isHost: false,
            joinMode: .meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: nil,
            allowRoomCreation: false,
            user: nil
        )
        viewModel.socketManager.onDisconnected?("io server disconnect")
        #expect(await classifierSettle { viewModel.shell.session.outcome?.kind == .serverDisconnected })
        #expect(viewModel.shell.session.phase == .outcome)
        #expect(viewModel.state.connectionState == .disconnected)
        #expect(viewModel.shell.feedbackState.token.kind == .connectionLost)
        let outcomeID = viewModel.state.terminalOutcome?.id
        let sequence = viewModel.shell.feedbackState.token.sequence

        viewModel.socketManager.onDisconnected?("io server disconnect")
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.terminalOutcome?.id == outcomeID)
        #expect(viewModel.shell.feedbackState.token.sequence == sequence)

        #expect(viewModel.state.errorMessage == nil)
    }

    @Test func aRawSocketErrorNoLongerReachesTheBanner() async {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.socketManager.onError?(NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "xhr poll error"]))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.errorMessage == nil)
    }
}

@MainActor
private func classifierSettle(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
#endif

private func classifierSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private struct ClassifierSourceRangeMissing: Error {
    let marker: String
}

private func classifierBody(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw ClassifierSourceRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw ClassifierSourceRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
