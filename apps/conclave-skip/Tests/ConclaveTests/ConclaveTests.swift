import XCTest
import Foundation
@testable import Conclave

@available(macOS 13, *)
final class ConclaveTests: XCTestCase {

    func testNativeSfuClientEventsIncludeConsumerClose() throws {
        XCTAssertEqual(SfuClientEvent.closeConsumer.rawValue, "closeConsumer")
        XCTAssertEqual(SfuClientEvent.adminSetPolicies.rawValue, "admin:setPolicies")
        XCTAssertEqual(SfuClientEvent.gameStart.rawValue, "game:start")
        XCTAssertEqual(SfuClientEvent.gameVoteOpen.rawValue, "game:vote:open")
        XCTAssertEqual(SfuClientEvent.transcriptGetToken.rawValue, "transcript:getToken")
        XCTAssertEqual(SfuClientEvent.transcriptSfuRelayStatus.rawValue, "transcript:sfuRelayStatus")
        XCTAssertEqual(SfuClientEvent.transcriptSfuRelayStart.rawValue, "transcript:sfuRelayStart")
        XCTAssertEqual(SfuClientEvent.transcriptSfuRelayStop.rawValue, "transcript:sfuRelayStop")
        XCTAssertEqual(SfuServerEvent.participantConnectionState.rawValue, "participantConnectionState")
        XCTAssertEqual(SfuServerEvent.webinarParticipantJoined.rawValue, "webinar:participantJoined")
        XCTAssertEqual(SfuServerEvent.gameView.rawValue, "game:view")
        XCTAssertEqual(SfuServerEvent.gameSnapshot.rawValue, "game:snapshot")
    }

    func testNativeTranscriptRelayWireModelsDecodeWebSfuAcks() throws {
        let token = try JSONDecoder().decode(TranscriptTokenResponse.self, from: Data("""
        {
          "roomId": "room-a",
          "workerUrl": "wss://conclave.acmvit.in/transcript",
          "token": "tok_123",
          "expiresAt": 1781047107221,
          "capabilities": {
            "start": true,
            "takeover": false,
            "stop": true,
            "ask": true,
            "relayAudio": true
          }
        }
        """.utf8))
        let status = try JSONDecoder().decode(TranscriptSfuRelayStatusResponse.self, from: Data("""
        { "mode": "sfu", "status": "available", "available": true, "updatedAt": 1781047107222 }
        """.utf8))
        let start = try JSONDecoder().decode(TranscriptSfuRelayStartResponse.self, from: Data("""
        { "mode": "sfu", "success": true, "status": "available", "updatedAt": 1781047107223 }
        """.utf8))
        let stop = try JSONDecoder().decode(TranscriptSfuRelayStopResponse.self, from: Data("""
        { "success": true }
        """.utf8))

        XCTAssertEqual(token.roomId, "room-a")
        XCTAssertEqual(token.capabilities.relayAudio, true)
        XCTAssertEqual(status.status, "available")
        XCTAssertTrue(status.available)
        XCTAssertTrue(start.success)
        XCTAssertTrue(stop.success)
    }

    func testNativeGameWireModelsDecodeServerShapes() throws {
        let json = """
        {
          "active": true,
          "public": {
            "gameId": "trivia",
            "name": "Trivia",
            "phase": "question",
            "players": [{ "id": "u1", "name": "Ishaan" }],
            "hostId": "u1",
            "view": { "round": 1 },
            "finished": false,
            "hasLeaderboard": true
          },
          "view": { "answer": "hidden" },
          "vote": {
            "candidates": [{
              "id": "trivia",
              "name": "Trivia",
              "description": "Quick quiz",
              "minPlayers": 2,
              "maxPlayers": 12,
              "options": [{ "id": "rounds", "type": "number", "label": "Rounds", "min": 1, "max": 10, "default": 3 }],
              "hasLeaderboard": true
            }],
            "tally": { "trivia": 1 },
            "votes": { "u1": "trivia" },
            "totalPlayers": 1
          }
        }
        """

        let response = try JSONDecoder().decode(GameStateResponse.self, from: Data(json.utf8))

        XCTAssertTrue(response.active)
        XCTAssertEqual(response.publicState?.gameId, "trivia")
        XCTAssertEqual(response.publicState?.players.first?.name, "Ishaan")
        XCTAssertEqual(response.publicState?.view?.int("round"), 1)
        XCTAssertEqual(response.view?.string("answer"), "hidden")
        XCTAssertEqual(response.vote?.tally["trivia"], 1)
        XCTAssertEqual(response.vote?.candidates.first?.options.first?.defaultConfigValue.numberValue, 3)
    }

    func testNativeGameViewAndMovePayloadWireModelsPreserveObjects() throws {
        let notification = try JSONDecoder().decode(GamePlayerViewNotification.self, from: Data("""
        {
          "gameId": "trivia",
          "view": { "answered": true, "choice": 2, "score": 700 }
        }
        """.utf8))

        XCTAssertEqual(notification.gameId, "trivia")
        XCTAssertEqual(notification.view?.bool("answered"), true)
        XCTAssertEqual(notification.view?.int("choice"), 2)
        XCTAssertEqual(notification.view?.int("score"), 700)

        let request = GameMoveRequest(
            gameId: "trivia",
            type: "answer",
            payload: GameJSONValue.object(["choice": 2])
        )
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary)
        let payload = try XCTUnwrap(encoded["payload"] as? NSDictionary)

        XCTAssertEqual(encoded["gameId"] as? String, "trivia")
        XCTAssertEqual(encoded["type"] as? String, "answer")
        XCTAssertEqual((payload["choice"] as? NSNumber)?.intValue, 2)
    }

    func testNativeGameSheetAvoidsForcedUnwrapsForOptionalServerMetadata() throws {
        let source = try sourceFileContents("Sources/Conclave/Features/Meeting/MoreSheetView.swift")

        XCTAssertFalse(source.contains("rank!"))
        XCTAssertFalse(source.contains("category!"))
    }

    func testMeetingEntryOverlayPolicyStopsAtSafetyCap() throws {
        let startedAt = Date(timeIntervalSince1970: 1_000)

        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: Date(timeInterval: 11.9, since: startedAt),
            connectionState: ConnectionState.joined
        ))
        XCTAssertFalse(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: Date(timeInterval: 12.0, since: startedAt),
            connectionState: ConnectionState.joined
        ))
    }

    func testMeetingEntryOverlayPolicyOnlyCoversEntryConnectionStates() throws {
        let startedAt = Date(timeIntervalSince1970: 1_000)

        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: startedAt,
            connectionState: ConnectionState.connecting
        ))
        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: startedAt,
            connectionState: ConnectionState.joined
        ))
        XCTAssertFalse(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: startedAt,
            connectionState: ConnectionState.waiting
        ))
        XCTAssertFalse(MeetingEntryOverlayPolicy.shouldShow(
            isEnteringMeeting: true,
            startedAt: startedAt,
            now: startedAt,
            connectionState: ConnectionState.error
        ))
        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldClearMeetingEntry(on: ConnectionState.waiting))
        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldClearMeetingEntry(on: ConnectionState.error))
        XCTAssertTrue(MeetingEntryOverlayPolicy.shouldClearMeetingEntry(on: ConnectionState.disconnected))
    }

    @MainActor
    func testWaitingRoomApprovalRestartsMeetingEntryOverlay() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.waiting
        viewModel.state.waitingMessage = "Waiting for host"
        viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: "room-a",
            displayName: "Local User",
            socketDisplayName: nil,
            isGhost: false,
            isHost: false,
            joinMode: JoinMode.meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            clientId: nil,
            allowRoomCreation: false,
            user: nil
        )

        viewModel.socketManager.onJoinApproved?(JoinDecisionNotification(roomId: "room-a"))
        await Task.yield()

        XCTAssertEqual(viewModel.state.connectionState, ConnectionState.joining)
        XCTAssertNil(viewModel.state.waitingMessage)
        XCTAssertTrue(viewModel.state.isEnteringMeeting)
        XCTAssertEqual(viewModel.state.meetingEntryAction, MeetingEntryAction.join)
        XCTAssertNotNil(viewModel.state.meetingEntryStartedAt)
    }

    @MainActor
    func testNativeGamePlayerIdentityAcceptsSfuAndSessionAliases() throws {
        let state = MeetingState(
            userId: "local@example.com#native-session",
            sessionId: "native-session"
        )
        state.sfuUserId = "local@example.com"

        XCTAssertTrue(state.hasLocalGamePlayer(in: [
            GamePlayer(id: "local@example.com", name: "Local")
        ]))
        XCTAssertTrue(state.hasLocalGamePlayer(in: [
            GamePlayer(id: "local@example.com#native-session", name: "Local")
        ]))
        XCTAssertFalse(state.hasLocalGamePlayer(in: [
            GamePlayer(id: "local@example.com#other-session", name: "Other session")
        ]))
        XCTAssertFalse(state.hasLocalGamePlayer(in: [
            GamePlayer(id: "remote@example.com", name: "Remote")
        ]))
    }

    @MainActor
    func testNativeGameVoteIdentityAcceptsSfuAndSessionAliases() throws {
        let state = MeetingState(
            userId: "local@example.com#native-session",
            sessionId: "native-session"
        )
        state.sfuUserId = "local@example.com"

        XCTAssertEqual(
            state.localGameVoteId(in: GameVoteState(
                candidates: [],
                tally: [:],
                votes: ["local@example.com": "trivia"],
                totalPlayers: 1,
                roomId: nil
            )),
            "trivia"
        )
        XCTAssertEqual(
            state.localGameVoteId(in: GameVoteState(
                candidates: [],
                tally: [:],
                votes: ["local@example.com#native-session": "reaction"],
                totalPlayers: 1,
                roomId: nil
            )),
            "reaction"
        )
        XCTAssertNil(state.localGameVoteId(in: GameVoteState(
            candidates: [],
            tally: [:],
            votes: ["local@example.com#other-session": "bluff"],
            totalPlayers: 1,
            roomId: nil
        )))
    }

    func testNativeGameConfigDraftPolicyMatchesWebLauncherDefaults() throws {
        let game = GameCatalogEntry(
            id: "trivia",
            name: "Trivia",
            description: "Quick-fire quiz",
            minPlayers: 1,
            maxPlayers: 24,
            options: [
                GameOptionSpec(
                    id: "questions",
                    type: "number",
                    label: "Questions",
                    min: 3,
                    max: 15,
                    defaultNumber: 7,
                    presets: [5, 7, 10]
                ),
                GameOptionSpec(
                    id: "pace",
                    type: "select",
                    label: "Pace",
                    defaultString: "normal",
                    choices: [
                        GameOptionChoice(value: "relaxed", label: "Relaxed"),
                        GameOptionChoice(value: "normal", label: "Normal"),
                        GameOptionChoice(value: "fast", label: "Fast")
                    ]
                ),
                GameOptionSpec(
                    id: "topic",
                    type: "text",
                    label: "Topic",
                    defaultString: "",
                    placeholder: "Anything",
                    maxLength: 10
                )
            ],
            hasLeaderboard: true
        )

        let initial = GameConfigDraftPolicy.initialDrafts(for: game)
        let resolved = GameConfigDraftPolicy.resolvedOptions(for: game, drafts: [
            "questions": GameConfigValue.number(99),
            "pace": GameConfigValue.string("invalid"),
            "topic": GameConfigValue.string("  production design  ")
        ])

        XCTAssertEqual(initial["questions"]?.numberValue, 7)
        XCTAssertEqual(initial["pace"]?.stringValue, "normal")
        XCTAssertEqual(initial["topic"]?.stringValue, "")
        XCTAssertEqual(resolved["questions"]?.numberValue, 15)
        XCTAssertEqual(resolved["pace"]?.stringValue, "normal")
        XCTAssertEqual(resolved["topic"]?.stringValue, "production")
    }

    func testNativeGamesSheetCoversEveryWebGameRenderer() throws {
        let webRegistry = try repoFileContents("apps/web/src/app/components/games/registry.tsx")
        let nativeSheet = try sourceFileContents("Sources/Conclave/Features/Meeting/MoreSheetView.swift")
        let nativeWordle = try sourceFileContents("Sources/Conclave/Features/Meeting/WordleGameView.swift")

        let expectedGameIds = [
            "trivia",
            "bluff",
            "would-you-rather",
            "most-likely-to",
            "reaction",
            "imposter",
            "wordle"
        ]

        for gameId in expectedGameIds {
            XCTAssertTrue(webRegistry.contains("\(gameId):") || webRegistry.contains("\"\(gameId)\":"))
            XCTAssertTrue(
                nativeSheet.contains("case \"\(gameId)\""),
                "Native games sheet is missing renderer branch for \(gameId)."
            )
        }
        XCTAssertTrue(nativeSheet.contains("WordleGameView("))
        XCTAssertTrue(nativeWordle.contains("struct WordleGameView"))
    }

    func testMoreSheetShowsToolsWhenOnlyTranscriptToolIsAvailable() throws {
        XCTAssertTrue(MoreSheetVisibilityPolicy.canShowToolsSection(
            canShowAdminControls: false,
            canShowSharedBrowser: false,
            canShowGamesSection: false,
            canShowAppsSection: false,
            canShowTranscriptTool: true
        ))
        XCTAssertFalse(MoreSheetVisibilityPolicy.canShowToolsSection(
            canShowAdminControls: false,
            canShowSharedBrowser: false,
            canShowGamesSection: false,
            canShowAppsSection: false,
            canShowTranscriptTool: false
        ))
    }

    func testMeetingHeaderRoomPillDoesNotStretchAcrossCompactScreens() throws {
        XCTAssertLessThanOrEqual(MeetingHeaderLayout.roomPillMaxWidth, 224.0)
    }

#if !SKIP
    func testNativeSfuEventsStayGeneratedFromMeetingCoreRegistry() throws {
        let expectedSystemEvents = try parseMeetingCoreSfuEventRawValues(groupName: "system")
        let expectedClientEvents = try parseMeetingCoreSfuEventRawValues(groupName: "clientToServer")
        let expectedServerEvents = try parseMeetingCoreSfuEventRawValues(groupName: "serverToClient")

        XCTAssertEqual(try parseSwiftSfuEventRawValues(enumName: "SfuSystemEvent"), expectedSystemEvents)
        XCTAssertEqual(try parseSwiftSfuEventRawValues(enumName: "SfuClientEvent"), expectedClientEvents)
        XCTAssertEqual(try parseSwiftSfuEventRawValues(enumName: "SfuServerEvent"), expectedServerEvents)
    }

    func testNativeSocketManagersRegisterEverySfuServerEvent() throws {
        let serverEventRawValues = try parseSfuServerEventRawValues()
        let expectedRawValues = Set(serverEventRawValues.values)
        let iosRegisteredRawValues = try registeredServerEventRawValues(
            in: "Sources/Conclave/Core/Networking/SocketIOManager.swift",
            serverEventRawValues: serverEventRawValues
        )
        let androidRegisteredRawValues = try registeredServerEventRawValues(
            in: "Sources/Conclave/Skip/SocketIOManager+Android.kt",
            serverEventRawValues: serverEventRawValues
        )

        XCTAssertFalse(serverEventRawValues.isEmpty)
        XCTAssertTrue(
            expectedRawValues.subtracting(iosRegisteredRawValues).isEmpty,
            "iOS socket manager is missing server events: \(expectedRawValues.subtracting(iosRegisteredRawValues).sorted())"
        )
        XCTAssertTrue(
            expectedRawValues.subtracting(androidRegisteredRawValues).isEmpty,
            "Android socket manager is missing server events: \(expectedRawValues.subtracting(androidRegisteredRawValues).sorted())"
        )
    }

    func testNativeSocketManagersMirrorEverySfuClientEventConstant() throws {
        let clientEventRawValues = try parseSfuClientEventRawValues()
        let expectedRawValues = Set(clientEventRawValues.values)
        let iosMirroredRawValues = try mirroredClientEventRawValues(
            in: "Sources/Conclave/Core/Networking/SocketIOManager.swift",
            clientEventRawValues: clientEventRawValues
        )
        let androidMirroredRawValues = try mirroredClientEventRawValues(
            in: "Sources/Conclave/Skip/SocketIOManager+Android.kt",
            clientEventRawValues: clientEventRawValues
        )

        XCTAssertFalse(clientEventRawValues.isEmpty)
        XCTAssertTrue(
            expectedRawValues.subtracting(iosMirroredRawValues).isEmpty,
            "iOS socket manager is missing client event constants: \(expectedRawValues.subtracting(iosMirroredRawValues).sorted())"
        )
        XCTAssertTrue(
            expectedRawValues.subtracting(androidMirroredRawValues).isEmpty,
            "Android socket manager is missing client event constants: \(expectedRawValues.subtracting(androidMirroredRawValues).sorted())"
        )
    }
#endif

    func testNativeReactionEmojiOptionsMatchWebSurface() throws {
        XCTAssertEqual(MeetingReactionConstants.emojiOptions, ["👍", "👏", "😂", "❤️", "🎉", "😮"])
        XCTAssertFalse(MeetingReactionConstants.isAllowedEmoji("😢"))
        XCTAssertFalse(MeetingReactionConstants.isAllowedEmoji("🤔"))
    }

    func testNativeReactionAssetURLsResolveAgainstAppBaseURL() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in/room?debug=true"))
        let assetURL = MeetingReactionConstants.assetURL(value: "/reactions/aura.gif", baseURL: baseURL)
        let encodedAssetURL = MeetingReactionConstants.assetURL(value: "/reactions/aura%20burst.gif", baseURL: baseURL)

        XCTAssertEqual(assetURL?.absoluteString, "https://conclave.acmvit.in/reactions/aura.gif")
        XCTAssertEqual(encodedAssetURL?.absoluteString, "https://conclave.acmvit.in/reactions/aura%20burst.gif")
    }

    func testNativeReactionAssetURLsRejectInvalidValues() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in"))

        XCTAssertNil(MeetingReactionConstants.assetURL(value: "aura.gif", baseURL: baseURL))
        XCTAssertNil(MeetingReactionConstants.assetURL(value: "/reactions/../secret.gif", baseURL: baseURL))
        XCTAssertNil(MeetingReactionConstants.assetURL(value: "/reactions/%2e%2e/secret.gif", baseURL: baseURL))
        XCTAssertNil(MeetingReactionConstants.assetURL(value: "/avatars/user.png", baseURL: baseURL))
        XCTAssertNil(MeetingReactionConstants.assetURL(value: "/reactions/aura.gif", baseURL: nil))
    }

    func testJoinRoomResponseDecodesAckDisplayNameSnapshot() throws {
        let response = try JSONDecoder().decode(JoinRoomResponse.self, from: Data("""
        {
          "status": "waiting",
          "roomId": "room-a",
          "displayNameSnapshot": [
            {
              "userId": "nikhil@example.com#web-session",
              "displayName": "Nikhil Rao"
            }
          ]
        }
        """.utf8))

        let snapshot = try XCTUnwrap(response.displayNameSnapshot)
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(snapshot[0].userId, "nikhil@example.com#web-session")
        XCTAssertEqual(snapshot[0].displayName, "Nikhil Rao")
    }

    func testMeetingChatErrorPresentationKeepsTransportErrorsReadable() throws {
        XCTAssertEqual(
            MeetingChatErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Socket is not connected"]
            )),
            "Reconnect before sending chat."
        )
        XCTAssertEqual(
            MeetingChatErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Chat is locked by the host."]
            )),
            "Chat is locked by the host."
        )
    }

    @MainActor
    func testReactionSendFailureKeepsOptimisticReactionLikeWeb() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.sendReaction(MeetingReactionOption.emoji("👍"))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.activeReactions.count, 1)
        XCTAssertEqual(viewModel.state.activeReactions.first?.value, "👍")
        XCTAssertNil(viewModel.state.errorMessage)
    }

    func testWebinarAttendeeStatusMatchesWebCopy() throws {
        XCTAssertEqual(MeetingControlsBarCopy.webinarAttendeeStatus(count: 0), "0 attendees watching")
        XCTAssertEqual(MeetingControlsBarCopy.webinarAttendeeStatus(count: 1), "1 attendee watching")
        XCTAssertEqual(MeetingControlsBarCopy.webinarAttendeeStatus(count: 12), "12 attendees watching")
        XCTAssertEqual(MeetingControlsBarCopy.webinarAttendeeStatus(count: -1), "0 attendees watching")
    }

    func testNativeDisplayNameNormalizerMatchesWebWhitespaceBehavior() throws {
        XCTAssertEqual(NativeDisplayNameNormalizer.normalize("  Alex   Native \n User  "), "Alex Native User")
        XCTAssertEqual(NativeDisplayNameNormalizer.normalize("\n\t"), "")
    }

    func testNativeDisplayNameNormalizerMatchesSfuLengthLimit() throws {
        let maxLengthName = String(repeating: "A", count: NativeDisplayNameNormalizer.maxLength)
        XCTAssertEqual(NativeDisplayNameNormalizer.normalize(maxLengthName + "overflow"), maxLengthName)
        XCTAssertEqual(NativeDisplayNameNormalizer.normalize("  " + maxLengthName + "   overflow  "), maxLengthName)
    }

    func testNativeRoomIdNormalizerMatchesJoinSanitizationCase() throws {
        XCTAssertEqual(NativeRoomIdNormalizer.normalize("  Room-A  "), "room-a")
        XCTAssertNil(NativeRoomIdNormalizer.normalize("   "))
        XCTAssertTrue(NativeRoomIdNormalizer.matches(" Room-A ", "room-a"))
        XCTAssertFalse(NativeRoomIdNormalizer.matches("room-a", "room-b"))
    }

    func testSocketDisplayNameOverrideIsAdminOnly() throws {
        XCTAssertNil(MeetingViewModel.socketDisplayNameOverride("Nikhil", isAdmin: false))
        XCTAssertNil(MeetingViewModel.socketDisplayNameOverride("  ", isAdmin: true))
        XCTAssertEqual(MeetingViewModel.socketDisplayNameOverride("  Nikhil   Rao  ", isAdmin: true), "Nikhil Rao")
        XCTAssertEqual(
            MeetingViewModel.socketDisplayNameOverride(
                String(repeating: "A", count: NativeDisplayNameNormalizer.maxLength + 1),
                isAdmin: true
            ),
            String(repeating: "A", count: NativeDisplayNameNormalizer.maxLength)
        )
    }

    func testJoinPermissionCleanupPreservesRequestsDuringMeetingHandoff() throws {
        XCTAssertFalse(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.joining))
        XCTAssertFalse(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.joined))
        XCTAssertFalse(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.waiting))
        XCTAssertFalse(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.reconnecting))
    }

    func testJoinPermissionCleanupCancelsRequestsOutsideMeetingHandoff() throws {
        XCTAssertTrue(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.disconnected))
        XCTAssertTrue(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.connecting))
        XCTAssertTrue(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.connected))
        XCTAssertTrue(JoinPermissionCleanupPolicy.shouldCancelCallPermissionRequests(onDisappearFrom: ConnectionState.error))
    }

    func testJoinAsyncPermissionPolicyRejectsStalePermissionCallbacks() throws {
        XCTAssertTrue(JoinAsyncPermissionPolicy.shouldApply(generation: 4, currentGeneration: 4))
        XCTAssertFalse(JoinAsyncPermissionPolicy.shouldApply(generation: 4, currentGeneration: 5))
    }

    func testJoinGuestContinuationRequiresNameOrExistingIdentityLikeWeb() throws {
        XCTAssertFalse(JoinGuestContinuationPolicy.canContinue(
            guestName: "   ",
            displayName: " \n ",
            currentUserId: nil,
            isBlocked: false
        ))
        XCTAssertTrue(JoinGuestContinuationPolicy.canContinue(
            guestName: "  Native Guest  ",
            displayName: "",
            currentUserId: nil,
            isBlocked: false
        ))
        XCTAssertTrue(JoinGuestContinuationPolicy.canContinue(
            guestName: "",
            displayName: "  Routed Name  ",
            currentUserId: nil,
            isBlocked: false
        ))
        XCTAssertTrue(JoinGuestContinuationPolicy.canContinue(
            guestName: "",
            displayName: "",
            currentUserId: " guest-existing ",
            isBlocked: false
        ))
    }

    func testJoinGuestContinuationHonorsBlockedAuthActions() throws {
        XCTAssertFalse(JoinGuestContinuationPolicy.canContinue(
            guestName: "Native Guest",
            displayName: "",
            currentUserId: nil,
            isBlocked: true
        ))
    }

    func testNewMeetingPrejoinActionAllowsAnonymousGuestFallback() throws {
        XCTAssertTrue(JoinPrejoinActionPolicy.canCreateRoom(isBlocked: false))
        XCTAssertFalse(JoinPrejoinActionPolicy.canCreateRoom(isBlocked: true))
    }

    func testJoinRoomPrejoinActionRequiresNameOrIdentityLikeWebLobby() throws {
        XCTAssertFalse(JoinPrejoinActionPolicy.canJoinRoom(
            displayName: "   ",
            currentUserId: nil,
            isBlocked: false
        ))
        XCTAssertTrue(JoinPrejoinActionPolicy.canJoinRoom(
            displayName: "  Native Guest  ",
            currentUserId: nil,
            isBlocked: false
        ))
        XCTAssertTrue(JoinPrejoinActionPolicy.canJoinRoom(
            displayName: "   ",
            currentUserId: "auth-user-123",
            isBlocked: false
        ))
        XCTAssertFalse(JoinPrejoinActionPolicy.canJoinRoom(
            displayName: "Native Guest",
            currentUserId: nil,
            isBlocked: true
        ))
    }

    func testNewMeetingPrimaryActionSurfacesDisabledState() throws {
        let source = try sourceFileContents("Sources/Conclave/Features/Join/JoinView.swift")

        XCTAssertTrue(source.contains(".foregroundStyle(isCreateMeetingEnabled ? Color.white : ACMColors.textFaint)"))
        XCTAssertTrue(source.contains(".acmColorBackground(isCreateMeetingEnabled ? ACMColors.primaryOrange : ACMColors.subtleFill)"))
    }

    func testNativeJoinScreenStartsOnFlatLobbyLikeWeb() throws {
        let source = try sourceFileContents("Sources/Conclave/Features/Join/JoinView.swift")

        XCTAssertTrue(source.contains("@State private var phase: JoinPhase = .join"))
        XCTAssertTrue(source.contains("case auth, join"))
        XCTAssertFalse(source.contains("case welcome"))
        XCTAssertFalse(source.contains("private var welcomePhase"))
        XCTAssertFalse(source.contains("Get started"))
        XCTAssertFalse(source.contains("guard appState.isAuthenticated || appState.currentUser != nil"))
    }

    func testJoinGuestSignInFooterStaysVisibleForNoGuestsRecoveryOnCompact() throws {
        XCTAssertTrue(JoinGuestSignInFooterPolicy.shouldShow(
            hasSignedInAccount: false,
            isRegularSizeClass: false,
            isCompactPromptRecovery: true,
            joinFormErrorMessage: "Guests are not allowed in this meeting. Sign in to join."
        ))
    }

    func testJoinGuestSignInFooterStillHidesForNonAuthCompactRecovery() throws {
        XCTAssertFalse(JoinGuestSignInFooterPolicy.shouldShow(
            hasSignedInAccount: false,
            isRegularSizeClass: false,
            isCompactPromptRecovery: true,
            joinFormErrorMessage: "Enter the meeting invite code to join."
        ))
    }

    func testJoinGuestSignInFooterHidesForSignedInAccounts() throws {
        XCTAssertFalse(JoinGuestSignInFooterPolicy.shouldShow(
            hasSignedInAccount: true,
            isRegularSizeClass: true,
            isCompactPromptRecovery: false,
            joinFormErrorMessage: nil
        ))
    }

    func testJoinAdminIntentRequestsMeetingAdminForCustomClients() throws {
        XCTAssertTrue(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: "internal",
            targetClientId: nil,
            joinMode: JoinMode.meeting
        ))
        XCTAssertTrue(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: "public",
            targetClientId: "acm.internal",
            joinMode: JoinMode.meeting
        ))
    }

    func testJoinAdminIntentDoesNotRequestAdminForSharedConclaveOrWebinarJoins() throws {
        XCTAssertFalse(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: "conclave",
            targetClientId: nil,
            joinMode: JoinMode.meeting
        ))
        XCTAssertFalse(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: " Conclave ",
            targetClientId: nil,
            joinMode: JoinMode.meeting
        ))
        XCTAssertFalse(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: "public",
            targetClientId: nil,
            joinMode: JoinMode.meeting
        ))
        XCTAssertFalse(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: " Public ",
            targetClientId: nil,
            joinMode: JoinMode.meeting
        ))
        XCTAssertFalse(JoinAdminIntentPolicy.shouldRequestAdminJoin(
            resolvedClientId: "internal",
            targetClientId: nil,
            joinMode: JoinMode.webinarAttendee
        ))
    }

    func testJoinInviteCodeResolutionKeepsCodesScopedToJoinMode() throws {
        XCTAssertEqual(
            JoinInviteCodeResolutionPolicy.meetingInviteCode(
                joinMode: JoinMode.meeting,
                linkInviteCode: "link-meeting",
                enteredInviteCode: " entered-meeting ",
                allowsEnteredInviteCode: true
            ),
            "entered-meeting"
        )
        XCTAssertEqual(
            JoinInviteCodeResolutionPolicy.meetingInviteCode(
                joinMode: JoinMode.webinarAttendee,
                linkInviteCode: "link-meeting",
                enteredInviteCode: "stale-meeting",
                allowsEnteredInviteCode: true
            ),
            "link-meeting"
        )
        XCTAssertEqual(
            JoinInviteCodeResolutionPolicy.meetingInviteCode(
                joinMode: JoinMode.meeting,
                linkInviteCode: "link-meeting",
                enteredInviteCode: "hidden-stale-meeting",
                allowsEnteredInviteCode: false
            ),
            "link-meeting"
        )
        XCTAssertEqual(
            JoinInviteCodeResolutionPolicy.webinarInviteCode(
                joinMode: JoinMode.webinarAttendee,
                linkInviteCode: "link-webinar",
                enteredInviteCode: " entered-webinar ",
                allowsEnteredInviteCode: true
            ),
            "entered-webinar"
        )
        XCTAssertNil(
            JoinInviteCodeResolutionPolicy.webinarInviteCode(
                joinMode: JoinMode.meeting,
                linkInviteCode: "   ",
                enteredInviteCode: "stale-webinar",
                allowsEnteredInviteCode: true
            )
        )
        XCTAssertNil(
            JoinInviteCodeResolutionPolicy.webinarInviteCode(
                joinMode: JoinMode.webinarAttendee,
                linkInviteCode: nil,
                enteredInviteCode: "hidden-stale-webinar",
                allowsEnteredInviteCode: false
            )
        )
    }

    func testScreenSharePublishProfilePolicyMatchesWebThresholds() throws {
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: nil),
            ConnectionQuality.unknown
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: 0),
            ConnectionQuality.unknown
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: 280_000),
            ConnectionQuality.emergency
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: 550_000),
            ConnectionQuality.poor
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: 1_500_000),
            ConnectionQuality.fair
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(availableOutgoingBitrate: 1_500_001),
            ConnectionQuality.good
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.quality(
                availableOutgoingBitrate: 4_000_000,
                emergencyMode: true
            ),
            ConnectionQuality.emergency
        )
        XCTAssertEqual(
            ScreenSharePublishProfilePolicy.mostConstrained(ConnectionQuality.good, ConnectionQuality.fair),
            ConnectionQuality.fair
        )
    }

    func testJoinCompactPreviewLayoutKeepsTallScreensSpaciousAndShortScreensFitted() throws {
        let tallHeight = JoinCompactPreviewLayoutPolicy.height(
            containerHeight: 844,
            showsPrompt: false,
            showsTabs: true,
            showsGuestFooter: true,
            showsGhostToggle: false,
            isJoinTab: false
        )
        let shortHeight = JoinCompactPreviewLayoutPolicy.height(
            containerHeight: 640,
            showsPrompt: false,
            showsTabs: true,
            showsGuestFooter: true,
            showsGhostToggle: false,
            isJoinTab: false
        )

        XCTAssertGreaterThan(tallHeight, 184)
        XCTAssertLessThan(shortHeight, 184)
        XCTAssertGreaterThanOrEqual(shortHeight, 124)
    }

    func testJoinCompactPreviewLayoutGivesPromptRecoveryMoreRoomWithoutFooter() throws {
        let withFooter = JoinCompactPreviewLayoutPolicy.height(
            containerHeight: 640,
            showsPrompt: true,
            showsTabs: true,
            showsGuestFooter: true,
            showsGhostToggle: false,
            isJoinTab: true
        )
        let withoutFooter = JoinCompactPreviewLayoutPolicy.height(
            containerHeight: 640,
            showsPrompt: true,
            showsTabs: true,
            showsGuestFooter: false,
            showsGhostToggle: false,
            isJoinTab: true
        )

        XCTAssertEqual(withFooter, 0)
        XCTAssertGreaterThan(withoutFooter, withFooter)
        XCTAssertLessThanOrEqual(withoutFooter, 124)
    }

    func testJoinCompactPreviewLayoutAvoidsUnusablePreviewStrip() throws {
        XCTAssertEqual(
            JoinCompactPreviewLayoutPolicy.height(
                containerHeight: 640,
                showsPrompt: true,
                showsTabs: true,
                showsGuestFooter: true,
                showsGhostToggle: false,
                isJoinTab: true
            ),
            0
        )

        let usablePreviewHeight = JoinCompactPreviewLayoutPolicy.height(
            containerHeight: 710,
            showsPrompt: true,
            showsTabs: true,
            showsGuestFooter: true,
            showsGhostToggle: false,
            isJoinTab: true
        )
        XCTAssertGreaterThanOrEqual(usablePreviewHeight, 72)
    }

    func testSfuJoinInfoDerivesStableNativeIdentityFromTokenClaims() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "provider-user-id",
            "email": "Nikhil.Rao@Example.COM",
            "sessionId": "native-session"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        let identity = try XCTUnwrap(joinInfo.localIdentity(sessionId: "fallback-session"))

        XCTAssertEqual(identity.userKey, "nikhil.rao@example.com")
        XCTAssertEqual(identity.userId, "nikhil.rao@example.com#native-session")
    }

    func testSfuJoinInfoKeepsGuestIdentitySessionScoped() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "guest-fallback-session",
            "email": "guest-fallback-session@guest.conclave"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        let identity = try XCTUnwrap(joinInfo.localIdentity(sessionId: "fallback-session"))

        XCTAssertEqual(identity.userKey, "guest-fallback-session")
        XCTAssertEqual(identity.userId, "guest-fallback-session#fallback-session")
    }

    func testSfuJoinInfoRejectsMalformedTokenUserKeyDelimiter() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "provider-user#unexpected-session",
            "sessionId": "native-session"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        XCTAssertNil(joinInfo.localIdentity(sessionId: "fallback-session"))
    }

    func testSfuJoinInfoRejectsControlCharactersInTokenUserKey() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "provider-user\u{0007}",
            "sessionId": "native-session"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        XCTAssertNil(joinInfo.localIdentity(sessionId: "fallback-session"))
    }

    func testSfuJoinInfoFallsBackWhenTokenSessionIdHasControlCharacter() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "provider-user",
            "sessionId": "native\u{007F}session"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        let identity = try XCTUnwrap(joinInfo.localIdentity(sessionId: "fallback-session"))

        XCTAssertEqual(identity.userKey, "provider-user")
        XCTAssertEqual(identity.userId, "provider-user#fallback-session")
    }

    func testSfuJoinInfoRejectsControlCharactersInFallbackSessionId() throws {
        let token = try makeUnsignedJWT(payload: [
            "userId": "provider-user"
        ])
        let joinInfo = SfuJoinInfo(token: token, sfuUrl: "ws://127.0.0.1:3031", iceServers: nil)

        XCTAssertNil(joinInfo.localIdentity(sessionId: "fallback\u{001F}session"))
    }

    func testNativeJoinPayloadUsesDisplayedNameForSignedInUser() throws {
        let user = AppState.User(
            id: "auth-user-123",
            name: "Account Name",
            email: "person@example.com",
            provider: AppState.AuthProvider.google
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "  Meeting Alias  "
        )

        XCTAssertEqual(payload.id, "auth-user-123")
        XCTAssertEqual(payload.email, "person@example.com")
        XCTAssertEqual(payload.name, "Meeting Alias")
    }

    func testNativeJoinPayloadNormalizesDisplayedNameWhitespace() throws {
        let user = AppState.User(
            id: "auth-user-123",
            name: "Account Name",
            email: "person@example.com",
            provider: AppState.AuthProvider.google
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "  Alex   Native \n User  "
        )

        XCTAssertEqual(payload.name, "Alex Native User")
    }

    func testNativeJoinPayloadFallsBackToAccountNameWhenDisplayedNameIsEmpty() throws {
        let user = AppState.User(
            id: "auth-user-123",
            name: "Account Name",
            email: "person@example.com",
            provider: AppState.AuthProvider.google
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "   "
        )

        XCTAssertEqual(payload.name, "Account Name")
    }

    func testNativeJoinPayloadSanitizesInstitutionAccountNameWhenDisplayedNameIsEmpty() throws {
        let user = AppState.User(
            id: "auth-user-123",
            name: "  Nikhil   Rao 23BCE1234  ",
            email: "nikhil@vitstudent.ac.in",
            provider: AppState.AuthProvider.google
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "   "
        )

        XCTAssertEqual(payload.id, "auth-user-123")
        XCTAssertEqual(payload.email, "nikhil@vitstudent.ac.in")
        XCTAssertEqual(payload.name, "Nikhil Rao")
    }

    func testNativeJoinPayloadPreservesNeutralSignedInAccountIdentity() throws {
        let user = AppState.User(
            id: "auth-user-unknown-provider",
            name: "Account Name",
            email: "person@example.com",
            provider: AppState.AuthProvider.account
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "   "
        )

        XCTAssertEqual(payload.id, "auth-user-unknown-provider")
        XCTAssertEqual(payload.email, "person@example.com")
        XCTAssertEqual(payload.name, "Account Name")
    }

    func testNativeJoinPayloadKeepsGuestIdentitySessionScoped() throws {
        let user = AppState.User(
            id: "legacy-local-user",
            name: "Guest Name",
            email: "legacy@example.com",
            provider: AppState.AuthProvider.guest
        )

        let payload = JoinView.sfuJoinUserPayload(
            currentUser: user,
            displayName: "  Meeting Guest  "
        )

        XCTAssertNil(payload.id)
        XCTAssertNil(payload.email)
        XCTAssertEqual(payload.name, "Meeting Guest")
    }

    func testJoinFormErrorPolicyIgnoresStaleInviteCodeErrorForDifferentRoom() throws {
        let currentTarget = NativeJoinLinkTarget(
            roomId: "room-b",
            joinMode: JoinMode.meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            allowRoomCreation: false
        )

        XCTAssertFalse(JoinFormErrorPolicy.shouldDisplay(
            message: "Enter the meeting invite code to join.",
            currentTarget: currentTarget,
            failedRoomId: "room-a"
        ))
        XCTAssertFalse(JoinFormErrorPolicy.shouldRevealInviteCodeInput(
            message: "Enter the meeting invite code to join.",
            currentTarget: currentTarget,
            failedRoomId: "room-a"
        ))
    }

    func testJoinFormErrorPolicyRevealsInviteCodeForFailedRoom() throws {
        let currentTarget = NativeJoinLinkTarget(
            roomId: "room-a",
            joinMode: JoinMode.meeting,
            meetingInviteCode: nil,
            webinarInviteCode: nil,
            allowRoomCreation: false
        )

        XCTAssertTrue(JoinFormErrorPolicy.shouldDisplay(
            message: "Enter the meeting invite code to join.",
            currentTarget: currentTarget,
            failedRoomId: "room-a"
        ))
        XCTAssertTrue(JoinFormErrorPolicy.shouldRevealInviteCodeInput(
            message: "Enter the meeting invite code to join.",
            currentTarget: currentTarget,
            failedRoomId: "room-a"
        ))
    }

    func testJoinFormErrorPolicyKeepsPermissionErrorsVisible() throws {
        XCTAssertTrue(JoinFormErrorPolicy.shouldDisplay(
            message: "Allow camera access in Settings, then try again.",
            currentTarget: NativeJoinLinkTarget.invalid,
            failedRoomId: ""
        ))
        XCTAssertFalse(JoinFormErrorPolicy.shouldRevealInviteCodeInput(
            message: "Allow camera access in Settings, then try again.",
            currentTarget: NativeJoinLinkTarget.invalid,
            failedRoomId: ""
        ))
    }

    func testJoinWebinarAutoJoinPolicyKeepsGenerationGuard() throws {
        XCTAssertTrue(JoinWebinarAutoJoinPolicy.shouldApply(generation: 6, currentGeneration: 6))
        XCTAssertFalse(JoinWebinarAutoJoinPolicy.shouldApply(generation: 6, currentGeneration: 7))
    }

    func testJoinPrejoinAuthRefreshPolicyKeepsGenerationGuard() throws {
        XCTAssertTrue(JoinPrejoinAuthRefreshPolicy.shouldApply(generation: 4, currentGeneration: 4))
        XCTAssertFalse(JoinPrejoinAuthRefreshPolicy.shouldApply(generation: 4, currentGeneration: 5))
    }

    func testJoinRestoredAuthRefreshPolicyRequiresCurrentGenerationAndUser() throws {
        XCTAssertTrue(JoinRestoredAuthRefreshPolicy.shouldFinish(generation: 3, currentGeneration: 3))
        XCTAssertFalse(JoinRestoredAuthRefreshPolicy.shouldFinish(generation: 3, currentGeneration: 4))
        XCTAssertTrue(JoinRestoredAuthRefreshPolicy.shouldApply(
            generation: 3,
            currentGeneration: 3,
            currentUserId: "user-a",
            storedUserId: "user-a"
        ))
        XCTAssertFalse(JoinRestoredAuthRefreshPolicy.shouldApply(
            generation: 3,
            currentGeneration: 4,
            currentUserId: "user-a",
            storedUserId: "user-a"
        ))
        XCTAssertFalse(JoinRestoredAuthRefreshPolicy.shouldApply(
            generation: 3,
            currentGeneration: 3,
            currentUserId: "user-b",
            storedUserId: "user-a"
        ))
    }

    func testJoinAuthenticatedProviderPolicyPreservesKnownProvider() throws {
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: AppState.AuthProvider.apple),
            AppState.AuthProvider.apple
        )
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: AppState.AuthProvider.google),
            AppState.AuthProvider.google
        )
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: AppState.AuthProvider.account),
            AppState.AuthProvider.account
        )
    }

    func testJoinAuthenticatedProviderPolicyUsesNeutralAccountForUnknownSessionProvider() throws {
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: nil),
            AppState.AuthProvider.account
        )
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: AppState.AuthProvider.guest),
            AppState.AuthProvider.account
        )
        XCTAssertEqual(
            JoinAuthenticatedProviderPolicy.restoredSessionProvider(currentProvider: AppState.AuthProvider.none),
            AppState.AuthProvider.account
        )
    }

    func testScreenCaptureStartPolicyTimesOutOnlyPendingCurrentStart() throws {
        XCTAssertEqual(ScreenCaptureStartPolicy.startTimeoutNanoseconds, 12_000_000_000)
        XCTAssertTrue(ScreenCaptureStartPolicy.shouldApplyTimeout(
            generation: 2,
            currentGeneration: 2,
            hasServer: true,
            isConnected: false
        ))
        XCTAssertFalse(ScreenCaptureStartPolicy.shouldApplyTimeout(
            generation: 2,
            currentGeneration: 3,
            hasServer: true,
            isConnected: false
        ))
        XCTAssertFalse(ScreenCaptureStartPolicy.shouldApplyTimeout(
            generation: 2,
            currentGeneration: 2,
            hasServer: false,
            isConnected: false
        ))
        XCTAssertFalse(ScreenCaptureStartPolicy.shouldApplyTimeout(
            generation: 2,
            currentGeneration: 2,
            hasServer: true,
            isConnected: true
        ))
    }

    @MainActor
    func testLocalIdentityAliasDoesNotResolveToRemoteParticipant() throws {
        let state = MeetingState(userId: "alex@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "alex@example.com"
        state.displayName = "Alex Local"
        state.participants["alex@example.com#remote-session"] = Participant(
            id: "alex@example.com#remote-session",
            displayName: "Alex Remote"
        )

        XCTAssertNil(state.participant(for: "alex@example.com"))
        XCTAssertNil(state.participant(for: "alex@example.com#local-session"))
        XCTAssertEqual(state.participant(for: "alex@example.com#remote-session")?.displayName, "Alex Remote")
        XCTAssertEqual(state.displayName(for: "alex@example.com"), "Alex Local")
        XCTAssertEqual(state.displayName(for: "alex@example.com#remote-session"), "Alex Remote")
    }

    @MainActor
    func testSingleRemoteParticipantStaysVisibleWhenSelfViewFloats() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.auto
        state.selfViewMode = MeetingSelfViewMode.auto
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote"
        )

        XCTAssertEqual(state.participantCount, 2)
        XCTAssertEqual(state.resolvedSelfViewMode, .floating)
        XCTAssertEqual(state.visibleGridUserIds, ["remote@example.com#remote-session"])
        XCTAssertFalse(state.visibleGridIncludesLocalParticipant)
        XCTAssertTrue(state.visibleGridSnapshot().shouldShowDetachedSelfView)
    }

    @MainActor
    func testVoiceAgentIdentityIsHiddenFromNativeRosterAndLayout() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.auto
        state.selfViewMode = MeetingSelfViewMode.auto
        let agentUserId = "voice-agent-123@agent.conclave#agent-session"
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote"
        )
        state.participants[agentUserId] = Participant(
            id: agentUserId,
            displayName: "Voice Agent"
        )

        XCTAssertTrue(MeetingState.isVoiceAgentUserId("voice-agent-123"))
        XCTAssertTrue(MeetingState.isVoiceAgentUserId(agentUserId))
        XCTAssertTrue(MeetingState.isSyntheticRosterUserId(agentUserId))
        XCTAssertFalse(MeetingState.isSystemUserId(agentUserId))
        XCTAssertEqual(state.displayName(for: agentUserId), "Voice Agent")
        XCTAssertNil(state.participant(for: agentUserId))
        XCTAssertEqual(state.participantCount, 2)
        XCTAssertEqual(state.sortedParticipants.map(\.id), ["remote@example.com#remote-session"])
        XCTAssertEqual(state.visibleGridUserIds, ["remote@example.com#remote-session"])
    }

    @MainActor
    func testVoiceAgentProducerStateDoesNotCreateNativeRosterParticipant() throws {
        let viewModel = MeetingViewModel()
        let agentUserId = "voice-agent-456@agent.conclave#agent-session"

        viewModel.handleProducerState(ProducerInfo(
            producerId: "agent-audio-producer",
            producerUserId: agentUserId,
            kind: "audio",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.participants[agentUserId])
        XCTAssertEqual(viewModel.state.participantCount, 1)
        XCTAssertEqual(viewModel.state.visibleGridUserIds, [viewModel.state.userId])
    }

    @MainActor
    func testVisibleLayoutSnapshotsPreserveGridAndRailSemantics() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.selfViewMode = MeetingSelfViewMode.tile
        state.viewMaxTiles = 3

        for index in 0..<4 {
            let userId = "remote\(index)@example.com#remote-session"
            state.participants[userId] = Participant(id: userId, displayName: "Remote \(index)")
        }

        let grid = state.visibleGridSnapshot()
        XCTAssertEqual(grid.userIds, [
            "local@example.com#local-session",
            "remote0@example.com#remote-session",
            MeetingState.overflowTileId
        ])
        XCTAssertEqual(grid.tileCount, 3)
        XCTAssertEqual(grid.hiddenParticipantCount, 3)
        XCTAssertTrue(grid.includesLocalParticipant)
        XCTAssertFalse(grid.shouldShowDetachedSelfView)
        XCTAssertEqual(state.visibleGridUserIds, grid.userIds)
        XCTAssertEqual(state.hiddenGridParticipantsCount, grid.hiddenParticipantCount)
        XCTAssertFalse(state.isRemoteParticipantUserId(MeetingState.overflowTileId))
        XCTAssertEqual(
            grid.userIds.filter { state.isRemoteParticipantUserId($0) },
            ["remote0@example.com#remote-session"]
        )

        let strip = state.tileStripSnapshot()
        XCTAssertTrue(strip.shouldShowSelfTile)
        XCTAssertEqual(strip.participants.map(\.id), [
            "remote0@example.com#remote-session",
            "remote1@example.com#remote-session"
        ])
    }

    @MainActor
    func testTileStripSnapshotClampsRawViewMaxTiles() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.selfViewMode = MeetingSelfViewMode.tile
        state.viewMaxTiles = -10

        for index in 0..<3 {
            let userId = "remote\(index)@example.com#remote-session"
            state.participants[userId] = Participant(id: userId, displayName: "Remote \(index)")
        }

        let strip = state.tileStripSnapshot()
        XCTAssertTrue(strip.shouldShowSelfTile)
        XCTAssertEqual(strip.participants.map(\.id), ["remote0@example.com#remote-session"])
    }

    @MainActor
    func testMeetingLinkPercentEncodesRoomIdPathSegment() throws {
        XCTAssertEqual(
            MeetingState.meetingLink(for: " room/with?reserved#chars "),
            "https://conclave.acmvit.in/room%2Fwith%3Freserved%23chars"
        )
    }

    @MainActor
    func testLeavingRemoteParticipantDoesNotDriveVisibleMeetingLayout() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.auto
        state.selfViewMode = MeetingSelfViewMode.auto
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote",
            isMuted: true,
            isCameraOff: true,
            isLeaving: true
        )

        XCTAssertEqual(state.sortedParticipants.map(\.id), ["remote@example.com#remote-session"])
        XCTAssertEqual(state.presentParticipants.map(\.id), [])
        XCTAssertEqual(state.participantCount, 1)
        XCTAssertEqual(state.visibleTileParticipants.map(\.id), [])
        XCTAssertEqual(state.visibleGridUserIds, ["local@example.com#local-session"])
        XCTAssertEqual(state.resolvedViewMode, .tiled)
        XCTAssertNil(state.spotlightUserId)
    }

    @MainActor
    func testRealRemoteDisplayNameBeatsGenericGuestAliases() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayNames["nikhil@example.com#android-session"] = "Participant"
        state.displayNames["nikhil@example.com"] = "Nikhil Rao"
        state.participants["nikhil@example.com#android-session"] = Participant(
            id: "nikhil@example.com#android-session",
            displayName: "Unknown"
        )

        XCTAssertEqual(state.displayName(for: "nikhil@example.com#android-session"), "Nikhil Rao")
        XCTAssertEqual(state.displayName(for: "nikhil@example.com"), "Nikhil Rao")
        XCTAssertEqual(state.participant(for: "nikhil@example.com")?.id, "nikhil@example.com#android-session")
    }

    @MainActor
    func testJoinAckDisplayNameSnapshotSeedsRemotePresence() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "requested-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.isCameraOff = true

        viewModel.applyJoinSnapshot(JoinRoomResponse(
            rtpCapabilities: RtpCapabilities(codecs: nil, headerExtensions: nil),
            existingProducers: [],
            status: "joined",
            roomId: "room-a",
            displayNameSnapshot: [
                DisplayNameSnapshotUser(userId: "nikhil@example.com#web-session", displayName: "Nikhil Rao")
            ]
        ))

        XCTAssertEqual(viewModel.state.roomId, "room-a")
        XCTAssertTrue(viewModel.state.hasInitialPresenceSnapshot)
        XCTAssertEqual(viewModel.state.participantCount, 2)
        XCTAssertEqual(viewModel.state.visibleGridUserIds, ["nikhil@example.com#web-session"])
        XCTAssertEqual(viewModel.state.displayName(for: "nikhil@example.com#web-session"), "Nikhil Rao")

        viewModel.state.connectionState = ConnectionState.joined
        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testRemoteDisplayNameCollapsesRepeatedWhitespace() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        let remoteId = "nikhil@example.com#web-session"
        state.displayNames[remoteId] = "  Nikhil   Rao \n Web  "

        XCTAssertEqual(state.displayName(for: remoteId), "Nikhil Rao Web")
    }

    @MainActor
    func testGeneratedGuestDisplayNameDoesNotBeatRealAlias() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayNames["nikhil@example.com"] = "Nikhil Rao"
        state.displayNames["nikhil@example.com#android-session"] = "Guest 1781047107221"
        state.participants["nikhil@example.com#android-session"] = Participant(
            id: "nikhil@example.com#android-session",
            displayName: "Guest 1781047107221"
        )

        XCTAssertEqual(state.displayName(for: "nikhil@example.com#android-session"), "Nikhil Rao")
    }

    func testMediaFallbackDisplayNameUsesUserIdInsteadOfGeneratedGuestName() throws {
        XCTAssertEqual(
            MeetingState.mediaFallbackDisplayName(
                "Guest 1781047107221",
                userId: "nikhil.rao@example.com#web-session"
            ),
            "Nikhil Rao"
        )
        XCTAssertEqual(
            MeetingState.mediaFallbackDisplayName(
                "",
                userId: "meera@example.com#web-session-screen"
            ),
            "Meera"
        )
        XCTAssertEqual(
            MeetingState.mediaFallbackDisplayName(
                "Guest",
                userId: "guest-abc123#native-session"
            ),
            "Guest"
        )
        XCTAssertEqual(
            MeetingState.mediaFallbackDisplayName(
                "Actual Name",
                userId: "guest-abc123#native-session"
            ),
            "Actual Name"
        )
    }

    @MainActor
    func testGeneratedGuestDisplayNameFallsBackToCleanGuestLabel() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        let guestId = "guest-abc123#native-session"
        state.displayNames[guestId] = "Guest 1781047107221"
        state.participants[guestId] = Participant(
            id: guestId,
            displayName: "Participant"
        )

        XCTAssertEqual(state.displayName(for: guestId), "Guest")
        XCTAssertEqual(
            MeetingState.mediaFallbackDisplayName(
                "Guest 1781047107221",
                userId: guestId
            ),
            "Guest"
        )
    }

    @MainActor
    func testBaseDisplayNameSnapshotLabelsSessionParticipantTile() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.displayNames["nikhil@example.com"] = "Nikhil Rao"
        state.participants["nikhil@example.com#android-session"] = Participant(
            id: "nikhil@example.com#android-session",
            displayName: "Guest"
        )

        XCTAssertEqual(state.visibleGridUserIds, ["nikhil@example.com#android-session"])
        XCTAssertEqual(state.displayName(for: "nikhil@example.com#android-session"), "Nikhil Rao")
    }

    @MainActor
    func testAliasDuplicateRemoteParticipantCollapsesInVisibleSnapshots() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.auto
        state.selfViewMode = MeetingSelfViewMode.auto
        state.participants["nikhil@example.com"] = Participant(
            id: "nikhil@example.com",
            displayName: "Guest",
            isMuted: true,
            isCameraOff: true,
            isLeaving: true
        )
        state.participants["nikhil@example.com#web-session"] = Participant(
            id: "nikhil@example.com#web-session",
            displayName: "Nikhil Rao",
            isMuted: false,
            isCameraOff: false
        )

        XCTAssertEqual(state.participantCount, 2)
        XCTAssertEqual(state.participant(for: "nikhil@example.com")?.id, "nikhil@example.com#web-session")
        XCTAssertEqual(state.presentRemoteParticipantId(for: "nikhil@example.com"), "nikhil@example.com#web-session")
        XCTAssertEqual(state.sortedParticipants.map(\.id), ["nikhil@example.com#web-session"])
        XCTAssertEqual(state.visibleTileParticipants.map(\.id), ["nikhil@example.com#web-session"])
        XCTAssertEqual(state.visibleGridUserIds, ["nikhil@example.com#web-session"])
        XCTAssertFalse(state.visibleTileParticipants[0].isMuted)
        XCTAssertFalse(state.visibleTileParticipants[0].isCameraOff)
        XCTAssertFalse(state.visibleTileParticipants[0].isLeaving)
    }

    @MainActor
    func testBaseActiveSpeakerIdMatchesSessionScopedRemoteParticipant() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.participants["quiet@example.com#quiet-session"] = Participant(
            id: "quiet@example.com#quiet-session",
            displayName: "Quiet",
            isMuted: false,
            isCameraOff: true
        )
        state.participants["speaker@example.com#speaker-session"] = Participant(
            id: "speaker@example.com#speaker-session",
            displayName: "Speaker",
            isMuted: false,
            isCameraOff: true
        )
        state.activeSpeakerId = "speaker@example.com"
        state.hideTilesWithoutVideo = true

        XCTAssertTrue(state.isEffectiveActiveSpeaker("speaker@example.com#speaker-session"))
        XCTAssertFalse(state.isEffectiveActiveSpeaker("quiet@example.com#quiet-session"))
        XCTAssertEqual(state.sortedParticipants.first?.id, "speaker@example.com#speaker-session")
        XCTAssertEqual(state.visibleTileParticipants.map(\.id), ["speaker@example.com#speaker-session"])
    }

    @MainActor
    func testPresentRemoteParticipantIdResolvesAliasesForMediaPolicy() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.participants["speaker@example.com#speaker-session"] = Participant(
            id: "speaker@example.com#speaker-session",
            displayName: "Speaker",
            isMuted: false,
            isCameraOff: false
        )
        state.participants["leaving@example.com#old-session"] = Participant(
            id: "leaving@example.com#old-session",
            displayName: "Leaving",
            isLeaving: true
        )

        XCTAssertEqual(
            state.presentRemoteParticipantId(for: "speaker@example.com"),
            "speaker@example.com#speaker-session"
        )
        XCTAssertEqual(
            state.presentRemoteParticipantId(for: "speaker@example.com#speaker-session"),
            "speaker@example.com#speaker-session"
        )
        XCTAssertNil(state.presentRemoteParticipantId(for: "local@example.com"))
        XCTAssertNil(state.presentRemoteParticipantId(for: MeetingState.overflowTileId))
        XCTAssertNil(state.presentRemoteParticipantId(for: "missing@example.com"))
        XCTAssertNil(state.presentRemoteParticipantId(for: "leaving@example.com"))
    }

    @MainActor
    func testLocalBaseActiveSpeakerIdMatchesLocalSessionOnly() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.participants["local@example.com#remote-session"] = Participant(
            id: "local@example.com#remote-session",
            displayName: "Same account remote"
        )
        state.activeSpeakerId = "local@example.com"

        XCTAssertTrue(state.isEffectiveActiveSpeaker("local@example.com#local-session"))
        XCTAssertFalse(state.isEffectiveActiveSpeaker("local@example.com#remote-session"))
    }

    func testDisplayNameSnapshotAcceptsNameAlias() throws {
        let json = """
        {
          "roomId": "room-a",
          "users": [
            { "userId": "nikhil@example.com#web-session", "name": "Nikhil Rao" }
          ]
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(DisplayNameSnapshotNotification.self, from: json)

        XCTAssertEqual(snapshot.users.first?.userId, "nikhil@example.com#web-session")
        XCTAssertEqual(snapshot.users.first?.displayName, "Nikhil Rao")
    }

    func testUserJoinedAcceptsNameAlias() throws {
        let json = """
        {
          "roomId": "room-a",
          "userId": "nikhil@example.com#web-session",
          "name": "Nikhil Rao"
        }
        """.data(using: .utf8)!

        let notification = try JSONDecoder().decode(UserJoinedNotification.self, from: json)

        XCTAssertEqual(notification.userId, "nikhil@example.com#web-session")
        XCTAssertEqual(notification.displayName, "Nikhil Rao")
    }

    func testDisplayNamePayloadsAcceptCommonProfileNameAliases() throws {
        let snapshotJSON = """
        {
          "roomId": "room-a",
          "users": [
            { "userId": "nikhil@example.com#web-session", "display_name": "Nikhil Rao" }
          ]
        }
        """.data(using: .utf8)!
        let joinedJSON = """
        {
          "roomId": "room-a",
          "userId": "meera@example.com#web-session",
          "fullName": "Meera Iyer"
        }
        """.data(using: .utf8)!
        let updatedJSON = """
        {
          "roomId": "room-a",
          "userId": "dev@example.com#web-session",
          "username": "Dev User"
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(DisplayNameSnapshotNotification.self, from: snapshotJSON)
        let joined = try JSONDecoder().decode(UserJoinedNotification.self, from: joinedJSON)
        let updated = try JSONDecoder().decode(DisplayNameUpdatedNotification.self, from: updatedJSON)

        XCTAssertEqual(snapshot.users.first?.displayName, "Nikhil Rao")
        XCTAssertEqual(joined.displayName, "Meera Iyer")
        XCTAssertEqual(updated.displayName, "Dev User")
    }

    func testParticipantPeripheralPayloadsAcceptCommonProfileNameAliases() throws {
        let pendingRequestJSON = """
        {
          "roomId": "room-a",
          "userId": "nikhil@example.com#web-session",
          "name": "Nikhil Rao"
        }
        """.data(using: .utf8)!
        let pendingSnapshotJSON = """
        {
          "roomId": "room-a",
          "users": [
            { "userId": "meera@example.com#web-session", "display_name": "Meera Iyer" }
          ]
        }
        """.data(using: .utf8)!
        let adminParticipantJSON = """
        {
          "userId": "dev@example.com#web-session",
          "userKey": "dev@example.com",
          "fullName": "Dev User"
        }
        """.data(using: .utf8)!
        let webinarJoinedJSON = """
        {
          "roomId": "room-a",
          "userId": "tara@example.com#web-session",
          "username": "Tara Shah"
        }
        """.data(using: .utf8)!

        let pendingRequest = try JSONDecoder().decode(UserRequestedJoinNotification.self, from: pendingRequestJSON)
        let pendingSnapshot = try JSONDecoder().decode(PendingUsersSnapshotNotification.self, from: pendingSnapshotJSON)
        let adminParticipant = try JSONDecoder().decode(AdminRoomParticipantSnapshot.self, from: adminParticipantJSON)
        let webinarJoined = try JSONDecoder().decode(WebinarParticipantJoinedNotification.self, from: webinarJoinedJSON)

        XCTAssertEqual(pendingRequest.displayName, "Nikhil Rao")
        XCTAssertEqual(pendingSnapshot.users.first?.displayName, "Meera Iyer")
        XCTAssertEqual(adminParticipant.displayName, "Dev User")
        XCTAssertEqual(webinarJoined.displayName, "Tara Shah")
    }

    @MainActor
    func testDisplayNameUpdatedSuppressesSoloFallbackWithoutCreatingParticipant() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.hasInitialPresenceSnapshot = true

        viewModel.socketManager.onDisplayNameUpdated?(DisplayNameUpdatedNotification(
            userId: "nikhil@example.com#web-session",
            displayName: "Nikhil Rao",
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertNil(viewModel.state.participants["nikhil@example.com#web-session"])
        XCTAssertEqual(viewModel.state.displayNames["nikhil@example.com#web-session"], "Nikhil Rao")
        XCTAssertEqual(viewModel.state.participantCount, 1)
        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testDisplayNameUpdatedRefreshesExistingParticipant() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants["nikhil@example.com#web-session"] = Participant(
            id: "nikhil@example.com#web-session",
            displayName: "Guest"
        )

        viewModel.socketManager.onDisplayNameUpdated?(DisplayNameUpdatedNotification(
            userId: "nikhil@example.com",
            displayName: "Nikhil Rao",
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.participants["nikhil@example.com#web-session"]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.displayName(for: "nikhil@example.com#web-session"), "Nikhil Rao")
        XCTAssertEqual(viewModel.state.participantCount, 2)
    }

    @MainActor
    func testGeneratedGuestSnapshotDoesNotOverwriteUsefulDisplayName() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.displayNames["nikhil@example.com"] = "Nikhil Rao"
        viewModel.state.participants["nikhil@example.com#web-session"] = Participant(
            id: "nikhil@example.com#web-session",
            displayName: "Nikhil Rao"
        )

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "local@example.com#local-session", displayName: "Local"),
                DisplayNameSnapshotUser(userId: "nikhil@example.com#web-session", displayName: "Guest 1781047107221")
            ],
            roomId: "room-a"
        ))

        XCTAssertEqual(viewModel.state.participants["nikhil@example.com#web-session"]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.displayName(for: "nikhil@example.com#web-session"), "Nikhil Rao")
    }

    @MainActor
    func testDepartedBareDisplayNameUpdateDoesNotCreatePresenceEvidence() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.hasInitialPresenceSnapshot = true

        let departedSessionId = "nikhil@example.com#old-session"
        XCTAssertTrue(viewModel.markRemoteParticipantPresent(departedSessionId))
        viewModel.markRemoteParticipantDeparted(departedSessionId)
        viewModel.state.participants.removeValue(forKey: departedSessionId)
        viewModel.state.displayNames.removeAll()

        XCTAssertTrue(viewModel.shouldIgnoreDepartedParticipant("nikhil@example.com"))

        viewModel.socketManager.onDisplayNameUpdated?(DisplayNameUpdatedNotification(
            userId: "nikhil@example.com",
            displayName: "Nikhil Rao",
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertNil(viewModel.state.displayNames["nikhil@example.com"])
        XCTAssertEqual(viewModel.state.participantCount, 1)
        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testNewSessionClearsDepartedAccountDisplayNameStaleness() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.markRemoteParticipantDeparted("nikhil@example.com#old-session")
        XCTAssertTrue(viewModel.shouldIgnoreDepartedParticipant("nikhil@example.com"))

        let newSessionId = "nikhil@example.com#new-session"
        XCTAssertTrue(viewModel.markRemoteParticipantPresent(newSessionId))
        XCTAssertFalse(viewModel.shouldIgnoreDepartedParticipant("nikhil@example.com"))

        viewModel.socketManager.onDisplayNameUpdated?(DisplayNameUpdatedNotification(
            userId: "nikhil@example.com",
            displayName: "Nikhil Rao",
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.participants[newSessionId]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.displayNames["nikhil@example.com"], "Nikhil Rao")
        XCTAssertEqual(viewModel.state.participantCount, 2)
    }

    @MainActor
    func testAdminParticipantSnapshotRefreshesLocalDisplayNameAliasesAndChat() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.displayName = "Guest"
        viewModel.state.chatMessages = [
            ChatMessage(
                id: "chat-1",
                userId: "local@example.com#local-session",
                displayName: "Guest",
                content: "hello",
                timestamp: Date(timeIntervalSince1970: 0),
                roomId: "room-a"
            )
        ]

        viewModel.socketManager.onAdminRoomStateChanged?(AdminRoomStateChangedNotification(
            roomId: "room-a",
            snapshot: AdminRoomSnapshot(
                id: "room-a",
                hostUserId: nil,
                adminUserIds: nil,
                screenShareProducerId: nil,
                quality: nil,
                policies: nil,
                access: nil,
                appsState: nil,
                participants: [
                    AdminRoomParticipantSnapshot(
                        userId: "local@example.com",
                        userKey: "local@example.com",
                        displayName: "Alex Native",
                        role: nil,
                        mode: nil,
                        muted: nil,
                        cameraOff: nil,
                        pendingDisconnect: nil,
                        producers: nil
                    )
                ],
                pendingUsers: nil
            )
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.displayName, "Alex Native")
        XCTAssertEqual(viewModel.state.displayNames["local@example.com"], "Alex Native")
        XCTAssertEqual(viewModel.state.displayNames["local@example.com#local-session"], "Alex Native")
        XCTAssertEqual(viewModel.state.chatMessages.first?.displayName, "Alex Native")
    }

    @MainActor
    func testAdminParticipantSnapshotKeepsSameAccountRemoteSessionVisible() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "alex@example.com#native-session", sessionId: "native-session")
        viewModel.state.sfuUserId = "alex@example.com"
        viewModel.state.displayName = "Alex Native"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.viewMode = MeetingViewMode.tiled
        viewModel.state.selfViewMode = MeetingSelfViewMode.floating

        let remoteSessionId = "alex@example.com#web-session"
        viewModel.socketManager.onAdminRoomStateChanged?(AdminRoomStateChangedNotification(
            roomId: "room-a",
            snapshot: AdminRoomSnapshot(
                id: "room-a",
                hostUserId: nil,
                adminUserIds: nil,
                screenShareProducerId: nil,
                quality: nil,
                policies: nil,
                access: nil,
                appsState: nil,
                participants: [
                    AdminRoomParticipantSnapshot(
                        userId: remoteSessionId,
                        userKey: "alex@example.com",
                        displayName: "Alex Web",
                        role: nil,
                        mode: nil,
                        muted: true,
                        cameraOff: true,
                        pendingDisconnect: nil,
                        producers: nil
                    )
                ],
                pendingUsers: nil
            )
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.displayName, "Alex Native")
        XCTAssertEqual(viewModel.state.participant(for: remoteSessionId)?.displayName, "Alex Web")
        XCTAssertEqual(viewModel.state.participantCount, 2)
        XCTAssertEqual(viewModel.state.visibleGridUserIds, [remoteSessionId])
    }

    @MainActor
    func testAdminParticipantSnapshotBlocksWebinarAttendeeHostPromotion() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "host@example.com#native-session", sessionId: "native-session")
        viewModel.state.sfuUserId = "host@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isAdmin = true

        viewModel.socketManager.onAdminRoomStateChanged?(AdminRoomStateChangedNotification(
            roomId: "room-a",
            snapshot: AdminRoomSnapshot(
                id: "room-a",
                hostUserId: "host@example.com",
                adminUserIds: ["host@example.com"],
                screenShareProducerId: nil,
                quality: nil,
                policies: nil,
                access: nil,
                appsState: nil,
                participants: [
                    AdminRoomParticipantSnapshot(
                        userId: "tara@example.com#web-session",
                        userKey: "tara@example.com",
                        displayName: "Tara Shah",
                        role: "attendee",
                        mode: nil,
                        muted: nil,
                        cameraOff: nil,
                        pendingDisconnect: nil,
                        producers: nil
                    ),
                    AdminRoomParticipantSnapshot(
                        userId: "lee@example.com#web-session",
                        userKey: "lee@example.com",
                        displayName: "Lee Chen",
                        role: nil,
                        mode: JoinMode.webinarAttendee.rawValue,
                        muted: nil,
                        cameraOff: nil,
                        pendingDisconnect: nil,
                        producers: nil
                    ),
                    AdminRoomParticipantSnapshot(
                        userId: "maya@example.com#web-session",
                        userKey: "maya@example.com",
                        displayName: "Maya Rao",
                        role: "participant",
                        mode: nil,
                        muted: nil,
                        cameraOff: nil,
                        pendingDisconnect: nil,
                        producers: nil
                    )
                ],
                pendingUsers: nil
            )
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.participant(for: "tara@example.com#web-session")?.isWebinarAttendee, true)
        XCTAssertEqual(viewModel.state.participant(for: "lee@example.com#web-session")?.isWebinarAttendee, true)
        XCTAssertEqual(viewModel.state.participant(for: "maya@example.com#web-session")?.isWebinarAttendee, false)
        XCTAssertFalse(viewModel.state.canPromoteHost(userId: "tara@example.com#web-session"))
        XCTAssertFalse(viewModel.state.canPromoteHost(userId: "lee@example.com#web-session"))
        XCTAssertTrue(viewModel.state.canPromoteHost(userId: "maya@example.com#web-session"))
    }

    func testAppsStateDefaultsMissingLockedToFalse() throws {
        let json = """
        {
          "roomId": "room-a",
          "activeAppId": "whiteboard"
        }
        """.data(using: .utf8)!

        let notification = try JSONDecoder().decode(AppsStateNotification.self, from: json)

        XCTAssertEqual(notification.roomId, "room-a")
        XCTAssertEqual(notification.activeAppId, "whiteboard")
        XCTAssertFalse(notification.locked)
    }

    func testAppsStateKeepsExplicitLockedValue() throws {
        let json = """
        {
          "roomId": "room-a",
          "activeAppId": "whiteboard",
          "locked": true
        }
        """.data(using: .utf8)!

        let notification = try JSONDecoder().decode(AppsStateNotification.self, from: json)

        XCTAssertEqual(notification.roomId, "room-a")
        XCTAssertEqual(notification.activeAppId, "whiteboard")
        XCTAssertTrue(notification.locked)
    }

    @MainActor
    func testActiveAppNameUsesReadableFallbackForUnknownIds() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")

        state.activeAppId = "shared-notes_board"

        XCTAssertEqual(state.activeAppName, "Shared Notes Board")
    }

    @MainActor
    func testRoomlessAppYjsUpdateOnlyMutatesActiveApp() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.activeAppId = "whiteboard"

        viewModel.socketManager.onAppsYjsUpdate?(AppsYjsUpdateNotification(
            appId: "whiteboard",
            update: Data([0x01, 0x02]),
            roomId: nil
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.appId, "whiteboard")
        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.data, Data([0x01, 0x02]))
        XCTAssertEqual(viewModel.state.appYjsUpdateSequence, 1)

        viewModel.socketManager.onAppsYjsUpdate?(AppsYjsUpdateNotification(
            appId: "dev-playground",
            update: Data([0x03, 0x04]),
            roomId: nil
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.appId, "whiteboard")
        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.data, Data([0x01, 0x02]))
        XCTAssertEqual(viewModel.state.appYjsUpdateSequence, 1)
    }

    @MainActor
    func testRoomlessAppAwarenessUpdateIgnoresInactiveApp() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.activeAppId = "whiteboard"

        viewModel.socketManager.onAppsAwareness?(AppsAwarenessNotification(
            appId: "dev-playground",
            awarenessUpdate: Data([0x08, 0x09]),
            clientId: 12,
            roomId: nil
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertNil(viewModel.state.latestAppAwarenessUpdate)
        XCTAssertEqual(viewModel.state.appAwarenessUpdateSequence, 0)
    }

    func testMeetingConfigSnapshotAcceptsRoomlessBroadcast() throws {
        let json = """
        {
          "requiresInviteCode": true
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(MeetingConfigSnapshot.self, from: json)

        XCTAssertNil(snapshot.roomId)
        XCTAssertEqual(snapshot.requiresInviteCode, true)
    }

    func testWebinarConfigSnapshotAcceptsRoomlessBroadcast() throws {
        let json = """
        {
          "enabled": true,
          "publicAccess": false,
          "locked": true,
          "maxAttendees": 250,
          "attendeeCount": 12,
          "requiresInviteCode": true,
          "linkSlug": "native-briefing",
          "feedMode": "active-speaker"
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: json)

        XCTAssertNil(snapshot.roomId)
        XCTAssertEqual(snapshot.enabled, true)
        XCTAssertEqual(snapshot.publicAccess, false)
        XCTAssertEqual(snapshot.locked, true)
        XCTAssertEqual(snapshot.maxAttendees, 250)
        XCTAssertEqual(snapshot.attendeeCount, 12)
        XCTAssertEqual(snapshot.requiresInviteCode, true)
        XCTAssertEqual(snapshot.linkSlug, "native-briefing")
        XCTAssertTrue(snapshot.hasLinkSlug)
        XCTAssertEqual(snapshot.feedMode, "active-speaker")
    }

    func testWebinarConfigSnapshotTracksMissingLinkSlug() throws {
        let missingLinkSlugJSON = """
        {
          "enabled": true
        }
        """.data(using: .utf8)!
        let explicitNullLinkSlugJSON = """
        {
          "linkSlug": null
        }
        """.data(using: .utf8)!

        let missingLinkSlug = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: missingLinkSlugJSON)
        let explicitNullLinkSlug = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: explicitNullLinkSlugJSON)

        XCTAssertNil(missingLinkSlug.linkSlug)
        XCTAssertFalse(missingLinkSlug.hasLinkSlug)
        XCTAssertNil(explicitNullLinkSlug.linkSlug)
        XCTAssertTrue(explicitNullLinkSlug.hasLinkSlug)
    }

    @MainActor
    func testAdminConfigSettersReportSkippedInFlightActions() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isAdmin = true

        XCTAssertTrue(viewModel.setMeetingInviteCode("first-code"))
        XCTAssertFalse(viewModel.setMeetingInviteCode("second-code"))
        XCTAssertFalse(viewModel.clearMeetingInviteCode())
    }

    @MainActor
    func testAdminAccessListSettersReportRejectedActions() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isAdmin = true

        XCTAssertFalse(viewModel.allowAccessUserKey("  "))
        XCTAssertTrue(viewModel.allowAccessUserKey("Person@Example.COM"))
        XCTAssertTrue(viewModel.blockAccessUserKey("person@example.com"))

        viewModel.state.isAdmin = false
        XCTAssertFalse(viewModel.allowAccessUserKey("next@example.com"))

        viewModel.state.isAdmin = true
        viewModel.state.connectionState = ConnectionState.disconnected
        XCTAssertFalse(viewModel.blockAccessUserKey("next@example.com"))
    }

    @MainActor
    func testAdminNoticeShowsBannerWithoutAddingChatNoise() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.socketManager.onAdminNotice?(AdminNoticeNotification(
            roomId: "room-a",
            message: "  Recording starts soon  ",
            level: "warning",
            timestamp: nil,
            senderUserId: "admin@example.com"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.adminNoticeMessage, "Recording starts soon")
        XCTAssertEqual(viewModel.state.adminNoticeLevel, .warning)
        XCTAssertTrue(viewModel.state.systemMessages.isEmpty)
    }

    @MainActor
    func testRoomlessServerRestartNoticeSurfacesWhileWaiting() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.waiting

        viewModel.socketManager.onServerRestarting?(ServerRestartingNotification(
            roomId: nil,
            message: "  Server restarting soon  ",
            reconnecting: true
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.serverRestartNotice, "Server restarting soon")
    }

    @MainActor
    func testSharedBrowserActionsReportRejectedInput() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isAdmin = true

        XCTAssertFalse(viewModel.launchSharedBrowser(url: "ftp://example.com"))
        XCTAssertEqual(viewModel.state.errorMessage, "Only http and https URLs are supported.")
        XCTAssertFalse(viewModel.launchSharedBrowser(url: "mailto:person@example.com"))
        XCTAssertEqual(viewModel.state.errorMessage, "Only http and https URLs are supported.")
        XCTAssertTrue(viewModel.launchSharedBrowser(url: "example.com"))
        XCTAssertNil(viewModel.state.errorMessage)

        XCTAssertFalse(viewModel.navigateSharedBrowser(url: "example.com"))
        viewModel.state.isBrowserActive = true
        XCTAssertFalse(viewModel.navigateSharedBrowser(url: "not a url"))
        XCTAssertEqual(viewModel.state.errorMessage, "URLs cannot contain spaces.")
        XCTAssertTrue(viewModel.navigateSharedBrowser(url: "https://example.com/next"))
        XCTAssertNil(viewModel.state.errorMessage)
    }

    @MainActor
    func testRoomlessConfigBroadcastsApplyToCurrentNativeRoom() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.socketManager.onMeetingConfigChanged?(MeetingConfigSnapshot(
            roomId: nil,
            requiresInviteCode: true
        ))
        viewModel.socketManager.onWebinarConfigChanged?(WebinarConfigSnapshot(
            roomId: nil,
            enabled: true,
            publicAccess: false,
            locked: true,
            maxAttendees: 250,
            attendeeCount: 12,
            requiresInviteCode: true,
            linkSlug: "native-briefing",
            feedMode: "active-speaker"
        ))

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(viewModel.state.meetingRequiresInviteCode)
        XCTAssertTrue(viewModel.state.isWebinarEnabled)
        XCTAssertFalse(viewModel.state.isWebinarPublicAccess)
        XCTAssertTrue(viewModel.state.isWebinarLocked)
        XCTAssertEqual(viewModel.state.webinarMaxAttendees, 250)
        XCTAssertEqual(viewModel.state.webinarAttendeeCount, 12)
        XCTAssertTrue(viewModel.state.webinarRequiresInviteCode)
        XCTAssertEqual(viewModel.state.webinarLinkSlug, "native-briefing")
        XCTAssertEqual(viewModel.state.webinarLinkURL, "https://conclave.acmvit.in/w/native-briefing")
        XCTAssertEqual(viewModel.state.webinarFeedMode, "active-speaker")
    }

    @MainActor
    func testWebinarConfigEncodesLinkSlugAsSinglePathSegment() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.socketManager.onWebinarConfigChanged?(WebinarConfigSnapshot(
            roomId: nil,
            enabled: nil,
            publicAccess: nil,
            locked: nil,
            maxAttendees: nil,
            attendeeCount: nil,
            requiresInviteCode: nil,
            linkSlug: "native/briefing?x=1#intro",
            feedMode: nil
        ))

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.webinarLinkSlug, "native/briefing?x=1#intro")
        XCTAssertEqual(
            viewModel.state.webinarLinkURL,
            "https://conclave.acmvit.in/w/native%2Fbriefing%3Fx=1%23intro"
        )
    }

    @MainActor
    func testPartialWebinarConfigSnapshotPreservesExistingLinkSlug() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.webinarLinkSlug = "existing-briefing"
        viewModel.state.webinarLinkURL = "https://conclave.acmvit.in/w/existing-briefing"

        viewModel.socketManager.onWebinarConfigChanged?(WebinarConfigSnapshot(
            roomId: nil,
            enabled: false,
            publicAccess: nil,
            locked: nil,
            maxAttendees: nil,
            attendeeCount: nil,
            requiresInviteCode: nil,
            linkSlug: nil,
            feedMode: nil
        ))

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(viewModel.state.isWebinarEnabled)
        XCTAssertEqual(viewModel.state.webinarLinkSlug, "existing-briefing")
        XCTAssertEqual(viewModel.state.webinarLinkURL, "https://conclave.acmvit.in/w/existing-briefing")
    }

    @MainActor
    func testExplicitNullWebinarConfigSnapshotClearsExistingLinkSlug() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.webinarLinkSlug = "existing-briefing"
        viewModel.state.webinarLinkURL = "https://conclave.acmvit.in/w/existing-briefing"

        let json = """
        {
          "linkSlug": null
        }
        """.data(using: .utf8)!
        let snapshot = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: json)

        viewModel.socketManager.onWebinarConfigChanged?(snapshot)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertNil(viewModel.state.webinarLinkSlug)
        XCTAssertNil(viewModel.state.webinarLinkURL)
    }

    @MainActor
    func testDisplayNameSnapshotPrunesParticipantWithStaleProducer() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants["stale@example.com#old-session"] = Participant(
            id: "stale@example.com#old-session",
            displayName: "Stale"
        )
        viewModel.handleProducerState(ProducerInfo(
            producerId: "stale-video-producer",
            producerUserId: "stale@example.com#old-session",
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "local@example.com#local-session", displayName: "Local")
            ],
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.participants["stale@example.com#old-session"])
        XCTAssertFalse(viewModel.state.displayNames.keys.contains("stale@example.com#old-session"))
        XCTAssertEqual(viewModel.state.participantCount, 1)
    }

    @MainActor
    func testBareDisplayNameSnapshotKeepsSessionScopedRemoteParticipant() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants["nikhil@example.com#android-session"] = Participant(
            id: "nikhil@example.com#android-session",
            displayName: "Guest"
        )

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "nikhil@example.com", displayName: "Nikhil Rao")
            ],
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.participants["nikhil@example.com"])
        XCTAssertEqual(viewModel.state.participants["nikhil@example.com#android-session"]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.visibleGridUserIds, ["nikhil@example.com#android-session"])
    }

    @MainActor
    func testProducerStateUpgradesBareSnapshotParticipantToSessionId() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.selfViewMode = MeetingSelfViewMode.floating

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "nikhil@example.com", displayName: "Nikhil Rao")
            ],
            roomId: "room-a"
        ))
        XCTAssertNotNil(viewModel.state.participants["nikhil@example.com"])

        viewModel.state.pinnedUserId = "nikhil@example.com"
        viewModel.state.activeSpeakerId = "nikhil@example.com"
        viewModel.handleProducerState(ProducerInfo(
            producerId: "nikhil-video",
            producerUserId: "nikhil@example.com#android-session",
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.participants["nikhil@example.com"])
        XCTAssertEqual(viewModel.state.participants["nikhil@example.com#android-session"]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.visibleGridUserIds, ["nikhil@example.com#android-session"])
        XCTAssertEqual(viewModel.state.pinnedUserId, "nikhil@example.com#android-session")
        XCTAssertEqual(viewModel.state.activeSpeakerId, "nikhil@example.com#android-session")
    }

    @MainActor
    func testPausedRemoteScreenProducerClearsBaseActiveScreenShareAlias() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        let presenterId = "presenter@example.com#web-session"
        viewModel.state.activeScreenShareUserId = "presenter@example.com"
        viewModel.state.participants[presenterId] = Participant(
            id: presenterId,
            displayName: "Presenter",
            isScreenSharing: true
        )

        viewModel.handleProducerState(ProducerInfo(
            producerId: "presenter-screen",
            producerUserId: presenterId,
            kind: "video",
            type: ProducerType.screen.rawValue,
            paused: true,
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.activeScreenShareUserId)
        XCTAssertFalse(viewModel.state.participants[presenterId]?.isScreenSharing == true)
        XCTAssertNil(viewModel.state.presentationScreenShareUserId)
    }

    @MainActor
    func testPausedRemoteScreenProducerDoesNotClearDifferentSessionPresenter() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        let activePresenterId = "presenter@example.com#active-session"
        let pausedPresenterId = "presenter@example.com#old-session"
        viewModel.state.activeScreenShareUserId = activePresenterId
        viewModel.state.participants[activePresenterId] = Participant(
            id: activePresenterId,
            displayName: "Presenter",
            isScreenSharing: true
        )
        viewModel.state.participants[pausedPresenterId] = Participant(
            id: pausedPresenterId,
            displayName: "Presenter",
            isScreenSharing: true
        )

        viewModel.handleProducerState(ProducerInfo(
            producerId: "old-presenter-screen",
            producerUserId: pausedPresenterId,
            kind: "video",
            type: ProducerType.screen.rawValue,
            paused: true,
            roomId: "room-a"
        ))

        XCTAssertEqual(viewModel.state.activeScreenShareUserId, activePresenterId)
        XCTAssertTrue(viewModel.state.participants[activePresenterId]?.isScreenSharing == true)
        XCTAssertFalse(viewModel.state.participants[pausedPresenterId]?.isScreenSharing == true)
        XCTAssertEqual(viewModel.state.presentationScreenShareUserId, activePresenterId)
    }

    @MainActor
    func testRemoteProducerCloseWaitsForReplacementBeforeMarkingCameraOff() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        let remoteUserId = "nikhil@example.com#android-session"

        viewModel.handleProducerState(ProducerInfo(
            producerId: "old-video",
            producerUserId: remoteUserId,
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))
        XCTAssertEqual(viewModel.state.participants[remoteUserId]?.isCameraOff, false)

        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: "old-video",
            producerUserId: remoteUserId,
            roomId: "room-a",
            adminEnforced: nil
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(viewModel.state.participants[remoteUserId]?.isCameraOff, false)

        viewModel.handleProducerState(ProducerInfo(
            producerId: "replacement-video",
            producerUserId: remoteUserId,
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 1_700_000_000)

        XCTAssertEqual(viewModel.state.participants[remoteUserId]?.isCameraOff, false)
    }

    @MainActor
    func testAdminEnforcedRemoteProducerCloseMarksCameraOffImmediately() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        let remoteUserId = "nikhil@example.com#android-session"

        viewModel.handleProducerState(ProducerInfo(
            producerId: "remote-video",
            producerUserId: remoteUserId,
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))
        XCTAssertEqual(viewModel.state.participants[remoteUserId]?.isCameraOff, false)

        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: "remote-video",
            producerUserId: remoteUserId,
            roomId: "room-a",
            adminEnforced: true
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.participants[remoteUserId]?.isCameraOff, true)
    }

    func testAdminMediaActionResponsePolicyUsesExplicitProducersFirst() throws {
        let response = AdminMediaActionResponse(
            success: true,
            error: nil,
            userId: "remote@example.com",
            affectedProducers: nil,
            producers: [
                AdminMediaProducer(
                    producerId: "camera-producer",
                    kind: "video",
                    type: ProducerType.webcam.rawValue
                )
            ],
            closed: true,
            producerId: "fallback-producer"
        )

        let producers = AdminMediaActionResponsePolicy.closedProducers(
            from: response,
            fallbackProducerKind: "audio",
            fallbackProducerType: ProducerType.screen.rawValue
        )

        XCTAssertEqual(producers.count, 1)
        XCTAssertEqual(producers[0].producerId, "camera-producer")
        XCTAssertEqual(producers[0].kind, "video")
        XCTAssertEqual(producers[0].type, ProducerType.webcam.rawValue)
    }

    func testAdminMediaActionResponsePolicyBuildsFallbackClosedProducer() throws {
        let response = AdminMediaActionResponse(
            success: true,
            error: nil,
            userId: "remote@example.com",
            affectedProducers: nil,
            producers: nil,
            closed: true,
            producerId: " camera-producer "
        )

        let producers = AdminMediaActionResponsePolicy.closedProducers(
            from: response,
            fallbackProducerKind: " video ",
            fallbackProducerType: " \(ProducerType.webcam.rawValue) "
        )

        XCTAssertEqual(producers.count, 1)
        XCTAssertEqual(producers[0].producerId, "camera-producer")
        XCTAssertEqual(producers[0].kind, "video")
        XCTAssertEqual(producers[0].type, ProducerType.webcam.rawValue)
    }

    func testAdminMediaActionResponsePolicyRejectsIncompleteFallback() throws {
        let response = AdminMediaActionResponse(
            success: true,
            error: nil,
            userId: "remote@example.com",
            affectedProducers: nil,
            producers: nil,
            closed: true,
            producerId: "camera-producer"
        )

        XCTAssertTrue(AdminMediaActionResponsePolicy.closedProducers(from: response).isEmpty)
        XCTAssertTrue(AdminMediaActionResponsePolicy.closedProducers(
            from: response,
            fallbackProducerKind: "video",
            fallbackProducerType: "   "
        ).isEmpty)
    }

    func testWebinarFeedSpeakerPolicyKeepsRequestedSpeakerInActiveFeed() throws {
        let producers = [
            ProducerInfo(
                producerId: "producer-a",
                producerUserId: "speaker-a@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            ),
            ProducerInfo(
                producerId: "producer-b",
                producerUserId: "speaker-b@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            )
        ]

        XCTAssertEqual(
            WebinarFeedSpeakerPolicy.speakerUserId(
                requestedSpeakerUserId: " speaker-b@example.com#web-session ",
                producers: producers
            ),
            "speaker-b@example.com#web-session"
        )
    }

    func testWebinarFeedSpeakerPolicyMatchesRequestedBaseIdToSessionProducer() throws {
        let producers = [
            ProducerInfo(
                producerId: "producer-a",
                producerUserId: "speaker-a@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            ),
            ProducerInfo(
                producerId: "producer-b",
                producerUserId: "speaker-b@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            )
        ]

        XCTAssertEqual(
            WebinarFeedSpeakerPolicy.speakerUserId(
                requestedSpeakerUserId: "speaker-b@example.com",
                producers: producers
            ),
            "speaker-b@example.com#web-session"
        )
    }

    func testWebinarFeedSpeakerPolicyDoesNotMergeDifferentSessionSpeakers() throws {
        let producers = [
            ProducerInfo(
                producerId: "producer-a",
                producerUserId: "speaker-a@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            ),
            ProducerInfo(
                producerId: "producer-b",
                producerUserId: "speaker-b@example.com#new-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            )
        ]

        XCTAssertEqual(
            WebinarFeedSpeakerPolicy.speakerUserId(
                requestedSpeakerUserId: "speaker-b@example.com#old-session",
                producers: producers
            ),
            "speaker-a@example.com#web-session"
        )
    }

    func testWebinarFeedSpeakerPolicyFallsBackWhenRequestedSpeakerIsNotInFeed() throws {
        let producers = [
            ProducerInfo(
                producerId: "producer-a",
                producerUserId: "speaker-a@example.com#web-session",
                kind: "video",
                type: ProducerType.webcam.rawValue,
                paused: false,
                roomId: "room-a"
            )
        ]

        XCTAssertEqual(
            WebinarFeedSpeakerPolicy.speakerUserId(
                requestedSpeakerUserId: "stale@example.com#old-session",
                producers: producers
            ),
            "speaker-a@example.com#web-session"
        )
    }

    func testWebinarFeedSpeakerPolicyClearsSpeakerForEmptyFeed() throws {
        XCTAssertNil(WebinarFeedSpeakerPolicy.speakerUserId(
            requestedSpeakerUserId: "stale@example.com#old-session",
            producers: []
        ))
    }

    @MainActor
    func testDisplayNameSnapshotPrunesOldSameAccountSessionWhenNewSessionIsExact() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants["nikhil@example.com#old-session"] = Participant(
            id: "nikhil@example.com#old-session",
            displayName: "Old Nikhil"
        )

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "nikhil@example.com#new-session", displayName: "Nikhil Rao")
            ],
            roomId: "room-a"
        ))

        XCTAssertNil(viewModel.state.participants["nikhil@example.com#old-session"])
        XCTAssertEqual(viewModel.state.participants["nikhil@example.com#new-session"]?.displayName, "Nikhil Rao")
        XCTAssertEqual(viewModel.state.visibleGridUserIds, ["nikhil@example.com#new-session"])
    }

    @MainActor
    func testGenericRemoteDisplayNameDoesNotHideUsefulIdentityFallback() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        let remoteId = "nikhil.rao@example.com#web-session"
        state.displayNames[remoteId] = "Guest"
        state.participants[remoteId] = Participant(id: remoteId, displayName: "Guest")

        XCTAssertEqual(state.displayName(for: remoteId), "Nikhil Rao")
        XCTAssertEqual(state.displayName(for: "guest-abc#guest-session"), "Guest")
    }

    @MainActor
    func testOnlyRemoteParticipantStaysVisibleWhenVideoLessTilesAreHidden() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.displayName = "Local"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.tiled
        state.selfViewMode = MeetingSelfViewMode.floating
        state.hideTilesWithoutVideo = true
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote",
            isMuted: true,
            isCameraOff: true
        )

        XCTAssertEqual(state.participantCount, 2)
        XCTAssertEqual(state.visibleTileParticipants.map(\.id), ["remote@example.com#remote-session"])
        XCTAssertEqual(state.visibleGridUserIds, ["remote@example.com#remote-session"])
        XCTAssertFalse(state.visibleGridIncludesLocalParticipant)
    }

    @MainActor
    func testSoloInviteFallbackIsSuppressedByRemoteRosterEvidence() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote"
        )

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testFreshJoinedStateDoesNotShowSoloFallbackBeforePresenceSnapshot() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true

        XCTAssertFalse(viewModel.state.hasInitialPresenceSnapshot)
        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    #if !SKIP
    @MainActor
    func testCleanupResetsInitialPresenceSnapshotForNextRoom() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "old-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.hasInitialPresenceSnapshot = true

        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)

        await viewModel.cleanup(lifecycleGeneration: nil, notifyLocalState: true)

        XCTAssertFalse(viewModel.state.hasInitialPresenceSnapshot)

        viewModel.state.roomId = "new-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testCleanupResetsLocalMediaUiStateEvenWhenCallbacksAreSuppressed() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "old-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isMuted = false
        viewModel.state.isCameraOff = false
        viewModel.state.isScreenSharing = true
        viewModel.state.activeScreenShareUserId = viewModel.state.userId

        await viewModel.cleanup(lifecycleGeneration: nil, notifyLocalState: false)

        XCTAssertTrue(viewModel.state.isMuted)
        XCTAssertTrue(viewModel.state.isCameraOff)
        XCTAssertFalse(viewModel.state.isScreenSharing)
        XCTAssertNil(viewModel.state.activeScreenShareUserId)
    }
    #endif

    @MainActor
    func testSoloInviteFallbackWaitsForInitialPresenceSnapshot() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.hasInitialPresenceSnapshot = false

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "local@example.com#local-session", displayName: "Local")
            ],
            roomId: "room-a"
        ))

        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)

        viewModel.applyDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "local@example.com#local-session", displayName: "Local"),
                DisplayNameSnapshotUser(userId: "remote@example.com#web-session", displayName: "Remote")
            ],
            roomId: "room-a"
        ))

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
        XCTAssertEqual(viewModel.state.displayName(for: "remote@example.com#web-session"), "Remote")
    }

    @MainActor
    func testStaleParticipantConnectionStateDoesNotCreateRemotePresence() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isCameraOff = true
        viewModel.state.hasInitialPresenceSnapshot = true

        viewModel.applyParticipantConnectionState(ParticipantConnectionStateNotification(
            userId: "remote@example.com#web-session",
            roomId: "old-room",
            state: "reconnecting",
            reason: nil,
            graceMs: nil,
            downtimeMs: nil,
            updatedAt: nil
        ))

        XCTAssertNil(viewModel.state.participants["remote@example.com#web-session"])
        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)
    }

    func testParticipantConnectionStatusDismissPolicyRequiresSameCallAndReconnectedState() throws {
        XCTAssertEqual(
            ParticipantConnectionStatusDismissPolicy.dismissDelayNanoseconds,
            4_500_000_000
        )
        XCTAssertTrue(ParticipantConnectionStatusDismissPolicy.shouldDismiss(
            isSameCallContext: true,
            statusState: ParticipantConnectionState.reconnected
        ))
        XCTAssertFalse(ParticipantConnectionStatusDismissPolicy.shouldDismiss(
            isSameCallContext: false,
            statusState: ParticipantConnectionState.reconnected
        ))
        XCTAssertFalse(ParticipantConnectionStatusDismissPolicy.shouldDismiss(
            isSameCallContext: true,
            statusState: ParticipantConnectionState.reconnecting
        ))
        XCTAssertFalse(ParticipantConnectionStatusDismissPolicy.shouldDismiss(
            isSameCallContext: true,
            statusState: nil
        ))
    }

    func testReconnectRetryPolicyRequiresCurrentJoinAttemptAndReconnectIntent() throws {
        XCTAssertTrue(ReconnectRetryPolicy.shouldRun(
            isCurrentJoinAttempt: true,
            shouldRejoinAfterReconnect: true,
            isIntentionalLeave: false
        ))
        XCTAssertFalse(ReconnectRetryPolicy.shouldRun(
            isCurrentJoinAttempt: false,
            shouldRejoinAfterReconnect: true,
            isIntentionalLeave: false
        ))
        XCTAssertFalse(ReconnectRetryPolicy.shouldRun(
            isCurrentJoinAttempt: true,
            shouldRejoinAfterReconnect: false,
            isIntentionalLeave: false
        ))
        XCTAssertFalse(ReconnectRetryPolicy.shouldRun(
            isCurrentJoinAttempt: true,
            shouldRejoinAfterReconnect: true,
            isIntentionalLeave: true
        ))
    }

    @MainActor
    func testIdleSocketDisconnectDoesNotEnterMeetingReconnectState() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.connectionState = ConnectionState.connected
        viewModel.shouldRejoinAfterReconnect = false

        viewModel.socketManager.onDisconnected?("transport close")

        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(viewModel.state.connectionState, ConnectionState.disconnected)
        XCTAssertFalse(viewModel.shouldRejoinAfterReconnect)
    }

    func testMeetingSocketRoomEventPolicyRejectsUnknownRoomDuringJoin() throws {
        XCTAssertFalse(MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: "old-room",
            contextRoomId: "room-a",
            currentRoomId: "room-a",
            knownRoomAliases: ["room-a"]
        ))
    }

    func testMeetingSocketRoomEventPolicyAcceptsKnownAliasesAndRoomlessBroadcasts() throws {
        let aliases: Set<String> = ["requested-room", "resolved-room"]

        XCTAssertTrue(MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: "resolved-room",
            contextRoomId: "requested-room",
            currentRoomId: "resolved-room",
            knownRoomAliases: aliases
        ))
        XCTAssertTrue(MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: " Resolved-Room ",
            contextRoomId: " Requested-Room ",
            currentRoomId: "resolved-room",
            knownRoomAliases: aliases
        ))
        XCTAssertTrue(MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: nil,
            contextRoomId: "resolved-room",
            currentRoomId: "resolved-room",
            knownRoomAliases: aliases
        ))
        XCTAssertFalse(MeetingSocketRoomEventPolicy.shouldAccept(
            eventRoomId: "other-room",
            contextRoomId: " Requested-Room ",
            currentRoomId: "resolved-room",
            knownRoomAliases: aliases
        ))
    }

    func testMeetingSocketRoomEventPolicyAcceptsRoomlessStateOnlyWithActiveRoom() throws {
        XCTAssertFalse(MeetingSocketRoomEventPolicy.shouldAcceptRoomlessRoomStateEvent(
            currentRoomId: nil,
            knownRoomAliases: []
        ))
        XCTAssertFalse(MeetingSocketRoomEventPolicy.shouldAcceptRoomlessRoomStateEvent(
            currentRoomId: "   ",
            knownRoomAliases: []
        ))
        XCTAssertTrue(MeetingSocketRoomEventPolicy.shouldAcceptRoomlessRoomStateEvent(
            currentRoomId: " resolved-room ",
            knownRoomAliases: []
        ))
        XCTAssertTrue(MeetingSocketRoomEventPolicy.shouldAcceptRoomlessRoomStateEvent(
            currentRoomId: nil,
            knownRoomAliases: ["resolved-room"]
        ))
    }

    @MainActor
    func testPendingWaitingRoomReplayKeepsSnapshotAndDeltasInOrder() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"

        viewModel.applyPendingWaitingRoomEvents([
            PendingPreAckWaitingRoomEvent.snapshot(PendingUsersSnapshotNotification(
                users: [
                    PendingUserSnapshot(userId: "alex@example.com", displayName: "Alex"),
                    PendingUserSnapshot(userId: "bea@example.com", displayName: nil)
                ],
                roomId: "room-a"
            )),
            PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
                userId: "chris@example.com",
                displayName: " Chris ",
                roomId: "room-a"
            )),
            PendingPreAckWaitingRoomEvent.changed(PendingUserChangedNotification(
                userId: "alex@example.com",
                roomId: "room-a"
            )),
            PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
                userId: "stale@example.com",
                displayName: "Stale",
                roomId: "old-room"
            ))
        ])

        XCTAssertEqual(viewModel.state.pendingUsers, [
            "bea@example.com": "bea@example.com",
            "chris@example.com": "Chris"
        ])
    }

    func testPendingWaitingRoomBufferSnapshotSupersedesEarlierEvents() throws {
        var events: [PendingPreAckWaitingRoomEvent] = []
        events = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
                userId: "old@example.com",
                displayName: "Old",
                roomId: "room-a"
            )),
            to: events
        )
        events = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: PendingPreAckWaitingRoomEvent.snapshot(PendingUsersSnapshotNotification(
                users: [
                    PendingUserSnapshot(userId: "current@example.com", displayName: "Current")
                ],
                roomId: "room-a"
            )),
            to: events
        )

        XCTAssertEqual(events.count, 1)
        guard case .snapshot(let snapshot) = events[0] else {
            return XCTFail("Expected latest snapshot to replace older waiting room events")
        }
        XCTAssertEqual(snapshot.users.map(\.userId), ["current@example.com"])
    }

    func testPendingWaitingRoomBufferKeepsLatestDeltaPerUser() throws {
        var events: [PendingPreAckWaitingRoomEvent] = [
            PendingPreAckWaitingRoomEvent.snapshot(PendingUsersSnapshotNotification(
                users: [],
                roomId: "room-a"
            ))
        ]
        events = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
                userId: "alex@example.com",
                displayName: "Alex",
                roomId: "room-a"
            )),
            to: events
        )
        events = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: PendingPreAckWaitingRoomEvent.changed(PendingUserChangedNotification(
                userId: "alex@example.com",
                roomId: "room-a"
            )),
            to: events
        )
        events = PendingWaitingRoomEventBufferPolicy.bufferedEvents(
            afterAppending: PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
                userId: "alex@example.com",
                displayName: "Alex Again",
                roomId: "room-a"
            )),
            to: events
        )

        XCTAssertEqual(events.count, 2)
        guard case .requested(let request) = events[1] else {
            return XCTFail("Expected the latest per-user waiting room delta to win")
        }
        XCTAssertEqual(request.displayName, "Alex Again")
    }

    @MainActor
    func testPreAckWaitingRoomBufferReplaysCompactedEvents() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.appendPendingPreAckWaitingRoomEvent(PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
            userId: "old@example.com",
            displayName: "Old",
            roomId: "room-a"
        )))
        viewModel.appendPendingPreAckWaitingRoomEvent(PendingPreAckWaitingRoomEvent.snapshot(PendingUsersSnapshotNotification(
            users: [
                PendingUserSnapshot(userId: "alex@example.com", displayName: "Alex")
            ],
            roomId: "room-a"
        )))
        viewModel.appendPendingPreAckWaitingRoomEvent(PendingPreAckWaitingRoomEvent.requested(UserRequestedJoinNotification(
            userId: "bea@example.com",
            displayName: " Bea ",
            roomId: "room-a"
        )))
        viewModel.appendPendingPreAckWaitingRoomEvent(PendingPreAckWaitingRoomEvent.changed(PendingUserChangedNotification(
            userId: "alex@example.com",
            roomId: "room-a"
        )))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.pendingUsers, [
            "bea@example.com": "Bea"
        ])
    }

    @MainActor
    func testPendingRoomPolicyReplayAppliesOnlyCurrentRoomEvents() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"

        let events: [PendingPreAckRoomPolicyEvent] = [
            .roomLockChanged(RoomLockChangedNotification(locked: true, roomId: "room-a")),
            .noGuestsChanged(NoGuestsChangedNotification(noGuests: true, roomId: "room-a")),
            .chatLockChanged(ChatLockChangedNotification(locked: true, roomId: "room-a")),
            .dmStateChanged(DmStateChangedNotification(enabled: false, roomId: "room-a")),
            .ttsDisabledChanged(TtsDisabledChangedNotification(disabled: true, roomId: "room-a")),
            .reactionsDisabledChanged(ReactionsDisabledChangedNotification(disabled: true, roomId: "room-a")),
            .roomLockChanged(RoomLockChangedNotification(locked: false, roomId: "old-room")),
            .chatLockChanged(ChatLockChangedNotification(locked: false, roomId: "old-room")),
            .dmStateChanged(DmStateChangedNotification(enabled: true, roomId: "old-room")),
            .ttsDisabledChanged(TtsDisabledChangedNotification(disabled: false, roomId: "old-room")),
            .reactionsDisabledChanged(ReactionsDisabledChangedNotification(disabled: false, roomId: "old-room"))
        ]
        viewModel.applyPendingRoomPolicyEvents(events)

        XCTAssertTrue(viewModel.state.isRoomLocked)
        XCTAssertTrue(viewModel.state.isNoGuests)
        XCTAssertTrue(viewModel.state.isChatLocked)
        XCTAssertFalse(viewModel.state.isDmEnabled)
        XCTAssertTrue(viewModel.state.isTtsDisabled)
        XCTAssertTrue(viewModel.state.isReactionsDisabled)
    }

    @MainActor
    func testStaleJoinRejectedDecisionDoesNotEndCurrentWaitingRoom() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.waiting
        viewModel.state.waitingMessage = "Waiting for host"

        viewModel.socketManager.onJoinRejected?(JoinDecisionNotification(roomId: "old-room"))

        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertEqual(viewModel.state.connectionState, ConnectionState.waiting)
        XCTAssertEqual(viewModel.state.waitingMessage, "Waiting for host")
        XCTAssertNil(viewModel.state.errorMessage)
    }

    @MainActor
    func testPreAckRosterReplayAppliesOnlyCurrentRoomEvents() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        let staleUserId = "stale@example.com#old-session"
        let currentUserId = "remote@example.com#web-session"
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantMuted(ParticipantMutedNotification(
            userId: staleUserId,
            muted: true,
            roomId: "old-room"
        )))
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantCameraOff(ParticipantCameraOffNotification(
            userId: staleUserId,
            cameraOff: true,
            roomId: "old-room"
        )))
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.handRaised(HandRaisedNotification(
            userId: staleUserId,
            raised: true,
            timestamp: 1,
            roomId: "old-room"
        )))
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantMuted(ParticipantMutedNotification(
            userId: currentUserId,
            muted: true,
            roomId: "room-a"
        )))
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantCameraOff(ParticipantCameraOffNotification(
            userId: currentUserId,
            cameraOff: true,
            roomId: "room-a"
        )))
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.handRaised(HandRaisedNotification(
            userId: currentUserId,
            raised: true,
            timestamp: 2,
            roomId: "room-a"
        )))

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertNil(viewModel.state.participants[staleUserId])
        XCTAssertEqual(viewModel.state.participants[currentUserId]?.isMuted, true)
        XCTAssertEqual(viewModel.state.participants[currentUserId]?.isCameraOff, true)
        XCTAssertEqual(viewModel.state.participants[currentUserId]?.isHandRaised, true)
    }

    @MainActor
    func testPreAckRosterBufferKeepsNewestEventsOnly() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        let droppedUserId = "dropped@example.com#web-session"
        let retainedUserId = "retained@example.com#web-session"
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantMuted(ParticipantMutedNotification(
            userId: droppedUserId,
            muted: true,
            roomId: "room-a"
        )))
        for index in 0..<128 {
            viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.userJoined(UserJoinedNotification(
                userId: "filler-\(index)@example.com#web-session",
                displayName: "Filler \(index)",
                roomId: "room-a"
            )))
        }
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantMuted(ParticipantMutedNotification(
            userId: retainedUserId,
            muted: true,
            roomId: "room-a"
        )))

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertNil(viewModel.state.participants[droppedUserId])
        XCTAssertEqual(viewModel.state.participants[retainedUserId]?.isMuted, true)
    }

    @MainActor
    func testStalePreAckRosterEventsDoNotEvictCurrentRoomEvents() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        let retainedUserId = "retained@example.com#web-session"
        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.participantMuted(ParticipantMutedNotification(
            userId: retainedUserId,
            muted: true,
            roomId: "room-a"
        )))
        for index in 0..<256 {
            viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.userJoined(UserJoinedNotification(
                userId: "stale-\(index)@example.com#old-session",
                displayName: "Stale \(index)",
                roomId: "old-room"
            )))
        }

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.participants[retainedUserId]?.isMuted, true)
        XCTAssertFalse(viewModel.state.participants.keys.contains { $0.hasPrefix("stale-") })
    }

    @MainActor
    func testStalePreAckRosterEvidenceDoesNotSuppressSoloFallback() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.hasInitialPresenceSnapshot = true
        viewModel.state.isCameraOff = true

        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.userJoined(UserJoinedNotification(
            userId: "stale@example.com#old-session",
            displayName: "Stale",
            roomId: "old-room"
        )))

        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)

        viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.userJoined(UserJoinedNotification(
            userId: "remote@example.com#web-session",
            displayName: "Remote",
            roomId: "room-a"
        )))

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testPendingDisplayNameSnapshotUsesLatestPresenceEvidence() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.hasInitialPresenceSnapshot = true
        viewModel.state.isCameraOff = true

        viewModel.bufferPendingDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "remote@example.com#web-session", displayName: "Remote")
            ],
            roomId: "room-a"
        ))

        XCTAssertFalse(viewModel.shouldShowSoloWaitingTile)

        viewModel.bufferPendingDisplayNameSnapshot(DisplayNameSnapshotNotification(
            users: [
                DisplayNameSnapshotUser(userId: "local@example.com#local-session", displayName: "Local")
            ],
            roomId: "room-a"
        ))

        XCTAssertTrue(viewModel.shouldShowSoloWaitingTile)
    }

    @MainActor
    func testPreAckChatHistorySnapshotKeepsLatestOnly() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(
                    id: "stale",
                    userId: "remote@example.com#web-session",
                    displayName: "Remote",
                    content: "old history",
                    timestamp: 1_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                )
            ],
            roomId: "room-a"
        ))
        viewModel.bufferPendingChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(
                    id: "latest",
                    userId: "remote@example.com#web-session",
                    displayName: "Remote",
                    content: "latest history",
                    timestamp: 2_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                )
            ],
            roomId: "room-a"
        ))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.chatMessages.map(\.id), ["latest"])
    }

    @MainActor
    func testChatHistorySnapshotSeedsVisibleMessagesWithoutDuplicatesOrStaleRooms() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.displayNames["remote@example.com#web-session"] = "Remote"
        viewModel.state.chatMessages = [
            ChatMessage(
                id: "existing",
                userId: "remote@example.com#web-session",
                displayName: "Remote",
                content: "already here",
                timestamp: Date(timeIntervalSince1970: 2),
                roomId: "room-a"
            )
        ]

        viewModel.applyChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(
                    id: "later",
                    userId: "remote@example.com#web-session",
                    displayName: "Ignored payload name",
                    content: "later",
                    timestamp: 3_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                ),
                ChatMessageNotification(
                    id: "existing",
                    userId: "remote@example.com#web-session",
                    displayName: "Remote",
                    content: "duplicate",
                    timestamp: 4_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                ),
                ChatMessageNotification(
                    id: "hidden-dm",
                    userId: "remote@example.com#web-session",
                    displayName: "Remote",
                    content: "private",
                    timestamp: 1_000,
                    gif: nil,
                    isDirect: true,
                    dmTargetUserId: "someone-else@example.com#session",
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                )
            ],
            roomId: "room-a"
        ))

        viewModel.applyChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(
                    id: "stale",
                    userId: "remote@example.com#old-session",
                    displayName: "Remote",
                    content: "stale",
                    timestamp: 5_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                )
            ],
            roomId: "old-room"
        ))

        XCTAssertEqual(viewModel.state.chatMessages.map(\.id), ["existing", "later"])
        XCTAssertEqual(viewModel.state.chatMessages.last?.displayName, "Ignored payload name")
        XCTAssertEqual(viewModel.state.chatMessages.last?.roomId, "room-a")
    }

    @MainActor
    func testChatHistorySnapshotNormalizesTtsWhitespaceLikeWeb() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"

        viewModel.applyChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(
                    id: "tts-tab",
                    userId: "remote@example.com#web-session",
                    displayName: "Remote",
                    content: "/tts\thello world",
                    timestamp: 3_000,
                    gif: nil,
                    isDirect: false,
                    dmTargetUserId: nil,
                    dmTargetDisplayName: nil,
                    roomId: nil,
                    replyTo: nil
                )
            ],
            roomId: "room-a"
        ))

        XCTAssertEqual(viewModel.state.chatMessages.map(\.content), ["TTS: hello world"])
    }

    @MainActor
    func testConclaveAssistantStreamPayloadDecodesToNativeChatMessage() throws {
        let notification = try JSONDecoder().decode(ConclaveAssistantMessageNotification.self, from: Data("""
        {
          "id": "assistant-message-1",
          "content": "Here is the answer",
          "done": false,
          "timestamp": 1781047107221
        }
        """.utf8))

        let message = notification.chatMessage(taggedRoomId: "room-a")

        XCTAssertEqual(message.id, "assistant-message-1")
        XCTAssertEqual(message.userId, ConclaveAssistantChatIdentity.userId)
        XCTAssertEqual(message.displayName, ConclaveAssistantChatIdentity.displayName)
        XCTAssertEqual(message.content, "Here is the answer")
        XCTAssertEqual(message.timestamp, Date(timeIntervalSince1970: 1_781_047_107.221))
        XCTAssertEqual(message.roomId, "room-a")
        XCTAssertTrue(MeetingState.isSyntheticRosterUserId(ConclaveAssistantChatIdentity.userId))
    }

    @MainActor
    func testConclaveAssistantStreamUpdatesSingleNativeChatMessage() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"

        let firstTimestamp = Date(timeIntervalSince1970: 1)
        let first = viewModel.receiveChatMessage(ChatMessage(
            id: "assistant-message-1",
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "The full answer",
            timestamp: firstTimestamp,
            roomId: "room-a"
        ))
        let shorterChunk = viewModel.receiveChatMessage(ChatMessage(
            id: "assistant-message-1",
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "The full",
            timestamp: Date(timeIntervalSince1970: 2),
            roomId: "room-a"
        ))
        let longerChunk = viewModel.receiveChatMessage(ChatMessage(
            id: "assistant-message-1",
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "The full answer with more detail",
            timestamp: Date(timeIntervalSince1970: 3),
            roomId: "room-a"
        ))

        XCTAssertNotNil(first)
        XCTAssertNil(shorterChunk)
        XCTAssertNil(longerChunk)
        XCTAssertEqual(viewModel.state.chatMessages.count, 1)
        XCTAssertEqual(viewModel.state.chatMessages.first?.content, "The full answer with more detail")
        XCTAssertEqual(viewModel.state.chatMessages.first?.timestamp, firstTimestamp)
        XCTAssertEqual(viewModel.state.chatMessages.first?.displayName, ConclaveAssistantChatIdentity.displayName)
    }

    @MainActor
    func testEmptyConclaveAssistantPlaceholderIsReplacedByFinalAnswer() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"

        let placeholderTimestamp = Date(timeIntervalSince1970: 1)
        let placeholder = viewModel.receiveChatMessage(ChatMessage(
            id: "assistant-message-1",
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "",
            timestamp: placeholderTimestamp,
            roomId: "room-a"
        ))
        let finalAnswer = viewModel.receiveChatMessage(ChatMessage(
            id: "assistant-message-1",
            userId: ConclaveAssistantChatIdentity.userId,
            displayName: ConclaveAssistantChatIdentity.displayName,
            content: "Ok.",
            timestamp: Date(timeIntervalSince1970: 2),
            roomId: "room-a"
        ))

        XCTAssertNotNil(placeholder)
        XCTAssertNil(finalAnswer)
        XCTAssertEqual(viewModel.state.chatMessages.count, 1)
        XCTAssertEqual(viewModel.state.chatMessages.first?.content, "Ok.")
        XCTAssertEqual(viewModel.state.chatMessages.first?.timestamp, placeholderTimestamp)
    }

    @MainActor
    func testStaleChatCommandDoesNotMutateNextRoom() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "old-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.chatMessages = [
            ChatMessage(
                id: "old-message",
                userId: "remote@example.com#old-session",
                displayName: "Remote",
                content: "old",
                roomId: "old-room"
            )
        ]

        let clearCommand = try XCTUnwrap(ChatCommandParser.parse("/clear"))
        viewModel.executeChatCommand(clearCommand)

        viewModel.state.roomId = "new-room"
        viewModel.state.chatMessages = [
            ChatMessage(
                id: "new-message",
                userId: "remote@example.com#new-session",
                displayName: "Remote",
                content: "keep",
                roomId: "new-room"
            )
        ]

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.chatMessages.map(\.id), ["new-message"])
        XCTAssertTrue(viewModel.state.systemMessages.isEmpty)
    }

    func testNativeChatCommandsMatchWebCommandSurface() throws {
        XCTAssertEqual(
            ChatCommand.primaryCommands.map(\.rawValue),
            [
                "help",
                "dm",
                "tts",
                "me",
                "action",
                "raise",
                "lower",
                "mute",
                "unmute",
                "camera",
                "leave",
                "clear"
            ]
        )
        XCTAssertNil(ChatCommandParser.parse("/cameraon"))
        XCTAssertNil(ChatCommandParser.parse("/cameraoff"))
        XCTAssertEqual(ChatCommandParser.matchesPartialCommand("/camerao").map(\.rawValue), [])
    }

    func testNativeChatCommandParserMatchesWebWhitespace() throws {
        XCTAssertNil(ChatCommandParser.parse("/"))
        XCTAssertNil(ChatCommandParser.parse("/   "))

        let mute = try XCTUnwrap(ChatCommandParser.parse("/\tMUTE"))
        XCTAssertEqual(mute.command, ChatCommand.mute)
        XCTAssertEqual(mute.arguments, [])

        let tts = try XCTUnwrap(ChatCommandParser.parse("/tts\thello\nthere "))
        XCTAssertEqual(tts.command, ChatCommand.tts)
        XCTAssertEqual(tts.argumentText, "hello there")

        let dm = try XCTUnwrap(ChatCommandParser.parse("/dm   bob\thello\nthere "))
        XCTAssertEqual(dm.command, ChatCommand.dm)
        XCTAssertEqual(dm.argumentText, "bob hello there")
    }

    func testChatMessageContentPolicyMatchesWebWhitespace() throws {
        XCTAssertEqual(ChatMessageContentPolicy.ttsText(from: "/tts\tspeak up"), "speak up")
        XCTAssertEqual(ChatMessageContentPolicy.ttsText(from: "/TTS    speak up"), "speak up")
        XCTAssertEqual(ChatMessageContentPolicy.ttsText(from: "/tts speak\nignored"), "speak")
        XCTAssertNil(ChatMessageContentPolicy.ttsText(from: " /tts speak"))
        XCTAssertNil(ChatMessageContentPolicy.ttsText(from: "/tts"))

        XCTAssertEqual(ChatMessageContentPolicy.actionText(from: "/me\twaves"), "waves")
        XCTAssertEqual(ChatMessageContentPolicy.actionText(from: "/action\nnods"), "nods")
        XCTAssertEqual(ChatMessageContentPolicy.actionText(from: "/me waves\nignored"), "waves")
        XCTAssertEqual(ChatMessageContentPolicy.actionText(from: "* shrugs"), "shrugs")
        XCTAssertNil(ChatMessageContentPolicy.actionText(from: "* "))
    }

    func testDirectMessageParserMatchesServerWhitespace() throws {
        let tabSeparated = try XCTUnwrap(ChatCommandParser.parseDirectMessage("/dm\tremote\tsecret"))
        XCTAssertEqual(tabSeparated.target, "remote")
        XCTAssertEqual(tabSeparated.body, "secret")

        let newlineSeparated = try XCTUnwrap(ChatCommandParser.parseDirectMessage("/dm\nremote\nhello there"))
        XCTAssertEqual(newlineSeparated.target, "remote")
        XCTAssertEqual(newlineSeparated.body, "hello there")

        let mention = try XCTUnwrap(ChatCommandParser.parseDirectMessage("@remote:\tsecret"))
        XCTAssertEqual(mention.target, "remote")
        XCTAssertEqual(mention.body, "secret")
    }

    func testConclaveMentionIsNotParsedAsDirectMessage() throws {
        XCTAssertNil(ChatCommandParser.parseDirectMessage("@Conclave hello"))
        XCTAssertNil(ChatCommandParser.parseDirectMessage("@conclave: summarize this"))
        XCTAssertNil(ChatCommandParser.parseDirectMessage("@CONCLAVE, what did I miss?"))
        XCTAssertNotNil(ChatCommandParser.parseDirectMessage("@conclave-team hello"))
    }

    func testConclaveMentionParserMatchesNativeAssistantGuard() throws {
        XCTAssertEqual(ChatCommandParser.parseConclaveMention("@Conclave summarize this"), "summarize this")
        XCTAssertEqual(ChatCommandParser.parseConclaveMention("Hey @Conclave, what did I miss?"), "Hey what did I miss?")
        XCTAssertEqual(ChatCommandParser.parseConclaveMention("@CONCLAVE: recap"), "recap")
        XCTAssertEqual(ChatCommandParser.parseConclaveMention("@Conclave"), "")
        XCTAssertNil(ChatCommandParser.parseConclaveMention("foo@conclave.ai"))
        XCTAssertNil(ChatCommandParser.parseConclaveMention("@conclave-team hello"))
    }

    func testChatMentionContextPolicyMatchesWebWhitespace() throws {
        XCTAssertEqual(
            ChatMentionContextPolicy.context(for: "  @Remote.User", isChatDisabled: false, isDmEnabled: true),
            ChatMentionContext(mode: ChatMentionMode.at, query: "remote.user", replacementPrefix: "  ")
        )
        XCTAssertNil(ChatMentionContextPolicy.context(for: "@remote ", isChatDisabled: false, isDmEnabled: true))

        XCTAssertEqual(
            ChatMentionContextPolicy.context(for: "/dm\tRemote.User", isChatDisabled: false, isDmEnabled: true),
            ChatMentionContext(mode: ChatMentionMode.dm, query: "remote.user")
        )
        XCTAssertEqual(
            ChatMentionContextPolicy.context(for: "/dm\n", isChatDisabled: false, isDmEnabled: true),
            ChatMentionContext(mode: ChatMentionMode.dm, query: "")
        )
        XCTAssertNil(ChatMentionContextPolicy.context(for: "/dm remote hello", isChatDisabled: false, isDmEnabled: true))
        XCTAssertNil(ChatMentionContextPolicy.context(for: "/dm remote", isChatDisabled: true, isDmEnabled: true))
        XCTAssertNil(ChatMentionContextPolicy.context(for: "/dm remote", isChatDisabled: false, isDmEnabled: false))
    }

    func testChatMentionContextPolicySupportsTrailingAtMentionsLikeWeb() throws {
        XCTAssertEqual(
            ChatMentionContextPolicy.context(for: "hey @Remote.User", isChatDisabled: false, isDmEnabled: true),
            ChatMentionContext(mode: ChatMentionMode.at, query: "remote.user", replacementPrefix: "hey ")
        )
        XCTAssertEqual(
            ChatMentionContextPolicy.replacedTrailingAtMention(in: "hey @Rem", with: "remote.user"),
            "hey @remote.user "
        )
        XCTAssertNil(ChatMentionContextPolicy.context(for: "hey @remote ", isChatDisabled: false, isDmEnabled: true))
        XCTAssertNil(ChatMentionContextPolicy.context(for: "email me@remote", isChatDisabled: false, isDmEnabled: true))
    }

    func testChatSubmitReplyPolicyKeepsReplyForNonDmCommands() throws {
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/help", isDmEnabled: true))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/me waves", isDmEnabled: true))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/tts hello", isDmEnabled: true))
    }

    func testChatSubmitReplyPolicyClearsReplyForClearCommand() throws {
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/clear", isDmEnabled: true))
    }

    func testChatSubmitReplyPolicyClearsReplyForMessageSends() throws {
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("hello", isDmEnabled: true))
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("@remote hello", isDmEnabled: true))
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/dm remote hello", isDmEnabled: true))
    }

    func testChatSubmitReplyPolicyKeepsReplyForBlockedDm() throws {
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("@remote hello", isDmEnabled: false))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/dm remote hello", isDmEnabled: false))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("/dm\tremote hello", isDmEnabled: false))
    }

    func testChatSubmitReplyPolicyKeepsDraftForBlockedDm() throws {
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("@remote hello", isDmEnabled: false))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("/dm remote hello", isDmEnabled: false))
        XCTAssertFalse(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("/dm\tremote hello", isDmEnabled: false))
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("hello", isDmEnabled: false))
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("/dm remote hello", isDmEnabled: true))
    }

    func testChatSubmitReplyPolicyTreatsConclaveMentionAsRoomMessage() throws {
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit("@Conclave hello", isDmEnabled: false))
        XCTAssertTrue(ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit("@Conclave hello", isDmEnabled: false))
    }

    func testChatMessageLinkParserNormalizesBareDomainsAndPunctuation() throws {
        let links = ChatMessageLinkParser.links(in: "join at conclave.acmvit.in, or https://example.com/path.")

        XCTAssertEqual(links.map(\.display), ["conclave.acmvit.in", "https://example.com/path"])
        XCTAssertEqual(links.map { $0.url.absoluteString }, ["https://conclave.acmvit.in", "https://example.com/path"])
    }

    func testChatMessageLinkParserHandlesWrappedURLsLikeWebChat() throws {
        let links = ChatMessageLinkParser.links(in: "see (https://example.com/path), <www.acmvit.in>, and [conclave.acmvit.in]")

        XCTAssertEqual(links.map(\.display), ["https://example.com/path", "www.acmvit.in", "conclave.acmvit.in"])
        XCTAssertEqual(
            links.map { $0.url.absoluteString },
            ["https://example.com/path", "https://www.acmvit.in", "https://conclave.acmvit.in"]
        )
    }

    func testChatMessageLinkParserIgnoresEmailsAndDuplicateLinks() throws {
        let links = ChatMessageLinkParser.links(in: "mail me@acmvit.in then visit www.acmvit.in and www.acmvit.in")

        XCTAssertEqual(links.map(\.display), ["www.acmvit.in"])
        XCTAssertEqual(links.first?.url.absoluteString, "https://www.acmvit.in")
    }

    func testSendChatRequestEncodesGifAttachmentParityFields() throws {
        let request = SendChatRequest(
            content: "Clip title",
            gif: ChatGifAttachment(
                id: "clip-1",
                title: "Clip title",
                url: "https://static.klipy.com/clip.gif",
                previewUrl: "https://static.klipy.com/clip-preview.gif",
                pageUrl: "https://klipy.com/clip-1",
                width: 320,
                height: 180,
                kind: "clip",
                videoUrl: "https://static.klipy.com/clip.mp4",
                source: "klipy"
            )
        )

        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
        let gif = try XCTUnwrap(object["gif"] as? NSDictionary)

        XCTAssertEqual(object["content"] as? String, "Clip title")
        XCTAssertEqual(gif["kind"] as? String, "clip")
        XCTAssertEqual(gif["videoUrl"] as? String, "https://static.klipy.com/clip.mp4")
        XCTAssertEqual(gif["source"] as? String, "klipy")
    }

    func testChatMessageNotificationDecodesGifClipMetadata() throws {
        let notification = try JSONDecoder().decode(ChatMessageNotification.self, from: Data("""
        {
          "id": "message-1",
          "userId": "remote@example.com#session",
          "displayName": "Remote",
          "content": "Clip title",
          "timestamp": 1710000000000,
          "gif": {
            "id": "clip-1",
            "title": "Clip title",
            "url": "https://static.klipy.com/clip.gif",
            "previewUrl": "https://static.klipy.com/clip-preview.gif",
            "pageUrl": "https://klipy.com/clip-1",
            "width": 320,
            "height": 180,
            "kind": "clip",
            "videoUrl": "https://static.klipy.com/clip.mp4",
            "source": "klipy"
          }
        }
        """.utf8))

        XCTAssertEqual(notification.gif?.kind, "clip")
        XCTAssertEqual(notification.gif?.videoUrl, "https://static.klipy.com/clip.mp4")
        XCTAssertEqual(notification.chatMessage.gif?.kind, "clip")
    }

    func testChatGifAttachmentPresentationUsesClipPreviewAndBadge() throws {
        let clip = ChatGifAttachment(
            id: "clip-1",
            title: "Clip title",
            url: "https://static.klipy.com/clip.gif",
            previewUrl: "https://static.klipy.com/clip-preview.gif",
            pageUrl: nil,
            width: 320,
            height: 180,
            kind: "clip",
            videoUrl: "https://static.klipy.com/clip.mp4",
            source: "klipy"
        )

        XCTAssertTrue(ChatGifAttachmentPresentation.isClip(clip))
        XCTAssertEqual(ChatGifAttachmentPresentation.imageURLString(for: clip), "https://static.klipy.com/clip-preview.gif")
        XCTAssertEqual(ChatGifAttachmentPresentation.badgeText(for: clip), "CLIP")
        XCTAssertEqual(ChatGifAttachmentPresentation.previewLabel(for: clip), "Clip")
        XCTAssertEqual(ChatGifAttachmentPresentation.mediaHeight(for: clip, width: 240), 135, accuracy: 0.5)
    }

    func testChatGifAttachmentPresentationTreatsStickersAsTransparentMedia() throws {
        let sticker = ChatGifAttachment(
            id: "sticker-1",
            title: "Sticker",
            url: "https://static.klipy.com/sticker.webp",
            previewUrl: nil,
            pageUrl: nil,
            width: 128,
            height: 128,
            kind: "sticker",
            videoUrl: nil,
            source: "klipy"
        )

        XCTAssertTrue(ChatGifAttachmentPresentation.isSticker(sticker))
        XCTAssertFalse(ChatGifAttachmentPresentation.isClip(sticker))
        XCTAssertEqual(ChatGifAttachmentPresentation.previewLabel(for: sticker), "Sticker")
        XCTAssertEqual(ChatGifAttachmentPresentation.badgeText(for: sticker), "KLIPY")
    }

    func testChatGifAttachmentPresentationFallsBackForMissingDimensions() throws {
        let gif = ChatGifAttachment(
            id: "gif-1",
            title: " ",
            url: " https://static.klipy.com/fallback.gif ",
            previewUrl: nil,
            pageUrl: nil,
            width: nil,
            height: nil,
            kind: nil,
            videoUrl: nil,
            source: "klipy"
        )

        XCTAssertEqual(ChatGifAttachmentPresentation.title(for: gif), "GIF")
        XCTAssertEqual(ChatGifAttachmentPresentation.imageURLString(for: gif), "https://static.klipy.com/fallback.gif")
        XCTAssertEqual(ChatGifAttachmentPresentation.mediaHeight(for: gif, width: 240), 150)
        XCTAssertEqual(ChatGifAttachmentPresentation.previewLabel(for: gif), "GIF")
    }

    @MainActor
    func testClearChatCommandResetsUnreadCount() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.roomId = "room-a"
        viewModel.state.unreadChatCount = 3
        viewModel.state.chatMessages = [
            ChatMessage(id: "message-a", userId: "remote@example.com", displayName: "Remote", content: "hello", roomId: "room-a")
        ]

        let clearCommand = try XCTUnwrap(ChatCommandParser.parse("/clear"))
        viewModel.executeChatCommand(clearCommand)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.unreadChatCount, 0)
    }

    func testChatOverlayAutoDismissRequiresSameMessageAndRoom() throws {
        let visibleMessages = [
            ChatMessage(id: "same-id", userId: "remote@example.com", displayName: "Remote", content: "old room", roomId: "old-room"),
            ChatMessage(id: "other-id", userId: "remote@example.com", displayName: "Remote", content: "current room", roomId: "room-a")
        ]

        XCTAssertFalse(ChatOverlayAutoDismissPolicy.shouldDismiss(
            scheduledMessageId: "same-id",
            scheduledRoomId: "room-a",
            visibleMessages: visibleMessages
        ))
        XCTAssertTrue(ChatOverlayAutoDismissPolicy.shouldDismiss(
            scheduledMessageId: "same-id",
            scheduledRoomId: "old-room",
            visibleMessages: visibleMessages
        ))
        XCTAssertTrue(ChatOverlayAutoDismissPolicy.roomsMatch(" ROOM-A ", "room-a"))
    }

    func testBrowserActivityLoopReusesOnlySameCallContext() throws {
        let joinAttemptId = UUID()
        let nextJoinAttemptId = UUID()

        XCTAssertFalse(BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: false,
            existingRoomId: "room-a",
            existingJoinAttemptId: joinAttemptId,
            nextRoomId: "room-a",
            nextJoinAttemptId: joinAttemptId
        ))
        XCTAssertTrue(BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: true,
            existingRoomId: "room-a",
            existingJoinAttemptId: joinAttemptId,
            nextRoomId: "room-a",
            nextJoinAttemptId: joinAttemptId
        ))
        XCTAssertFalse(BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: true,
            existingRoomId: "room-a",
            existingJoinAttemptId: joinAttemptId,
            nextRoomId: "room-a",
            nextJoinAttemptId: nextJoinAttemptId
        ))
        XCTAssertFalse(BrowserActivityLoopPolicy.shouldReuseLoop(
            hasActiveTask: true,
            existingRoomId: "room-a",
            existingJoinAttemptId: joinAttemptId,
            nextRoomId: "room-b",
            nextJoinAttemptId: joinAttemptId
        ))
    }

    @MainActor
    func testUnmuteCommandReportsUnavailableInObserverMode() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "attendee@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "attendee@example.com"
        viewModel.state.roomId = "webinar-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.webinarRole = "attendee"
        viewModel.state.isMuted = true

        let unmuteCommand = try XCTUnwrap(ChatCommandParser.parse("/unmute"))
        viewModel.executeChatCommand(unmuteCommand)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(viewModel.state.isMuted)
        XCTAssertEqual(viewModel.state.systemMessages.last?.displayText, "Microphone is unavailable in this mode.")
    }

    @MainActor
    func testUnmuteCommandUsesSharedMediaPathWhenAvailable() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isMuted = true

        let unmuteCommand = try XCTUnwrap(ChatCommandParser.parse("/unmute"))
        viewModel.executeChatCommand(unmuteCommand)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(viewModel.state.isMuted)
        XCTAssertEqual(viewModel.state.systemMessages.last?.displayText, "Local used /unmute")
    }

    @MainActor
    func testChatCommandSendRespectsLockedChatBeforeSocketSend() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isChatLocked = true
        viewModel.state.isAdmin = false

        let actionCommand = try XCTUnwrap(ChatCommandParser.parse("/me waves"))
        viewModel.executeChatCommand(actionCommand)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(viewModel.state.chatMessages.isEmpty)
        XCTAssertEqual(viewModel.state.systemMessages.last?.displayText, "Command /me failed: Chat is locked by the host.")
        XCTAssertNil(viewModel.state.errorMessage)
    }

    @MainActor
    func testWhitespaceDmIsBlockedBeforeSocketSendWhenDisabled() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.isDmEnabled = false

        viewModel.sendChatMessage("/dm\tremote hello")

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(viewModel.state.chatMessages.isEmpty)
        XCTAssertEqual(viewModel.state.systemMessages.last?.displayText, "Private messages are disabled by the host.")
        XCTAssertNil(viewModel.state.errorMessage)
    }

    func testNativeConclaveMentionUsesAssistantFlowInsteadOfNativeBlocker() throws {
        let source = try sourceFileContents("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let chatViewsSource = try sourceFileContents("Sources/Conclave/Features/Meeting/ChatViews.swift")

        XCTAssertTrue(source.contains("sendConclaveQuestion(trimmed, question: conclaveQuestion, replyTo: replyTo)"))
        XCTAssertTrue(source.contains("appendConclaveAssistantPlaceholder(id: answerId"))
        XCTAssertTrue(source.contains("socketManager.requestConclaveAuthorization("))
        XCTAssertTrue(source.contains("NativeConclaveAssistantService.ask("))
        XCTAssertTrue(source.contains("socketManager.relayConclaveAnswer(relay)"))
        XCTAssertFalse(source.contains("Conclave AI is not available in the native app yet."))
        XCTAssertTrue(chatViewsSource.contains("return \"Thinking...\""))
        XCTAssertTrue(chatViewsSource.contains("content: ChatMessagePresentation.content(for: message)"))
    }

    @MainActor
    func testSendChatMessageShowsOptimisticMessageBeforeAckThenReplacesIt() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.sendChatMessage("hello native")

        XCTAssertEqual(viewModel.state.chatMessages.count, 1)
        XCTAssertTrue(viewModel.state.chatMessages[0].id.hasPrefix("optimistic-"))
        XCTAssertEqual(viewModel.state.chatMessages[0].userId, "local@example.com")
        XCTAssertEqual(viewModel.state.chatMessages[0].displayName, "Local")
        XCTAssertEqual(viewModel.state.chatMessages[0].content, "hello native")

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(viewModel.state.chatMessages.count, 1)
        XCTAssertFalse(viewModel.state.chatMessages[0].id.hasPrefix("optimistic-"))
        XCTAssertEqual(viewModel.state.chatMessages[0].content, "hello native")
    }

    @MainActor
    func testStaleChatSendRemovesOptimisticMessageAfterRoomChange() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        viewModel.sendChatMessage("stale optimistic")
        XCTAssertEqual(viewModel.state.chatMessages.count, 1)
        XCTAssertTrue(viewModel.state.chatMessages[0].id.hasPrefix("optimistic-"))

        viewModel.state.roomId = "room-b"

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(viewModel.state.chatMessages.isEmpty)
    }

    @MainActor
    func testRaiseCommandReportsUnavailableInWatchOnlyMode() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "attendee@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "attendee@example.com"
        viewModel.state.roomId = "webinar-room"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.webinarRole = "attendee"

        let raiseCommand = try XCTUnwrap(ChatCommandParser.parse("/raise"))
        viewModel.executeChatCommand(raiseCommand)

        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(viewModel.state.isHandRaised)
        XCTAssertEqual(viewModel.state.systemMessages.last?.displayText, "Hand raise is unavailable in watch-only mode.")
    }

    @MainActor
    func testStalePinnedParticipantDoesNotBlankSpotlightStage() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.spotlight
        state.pinnedUserId = "missing@example.com#old-session"
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote",
            isCameraOff: false
        )

        XCTAssertEqual(state.spotlightUserId, "remote@example.com#remote-session")
    }

    @MainActor
    func testStalePinnedParticipantDoesNotForceAutoSpotlightLayout() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.auto
        state.pinnedUserId = "missing@example.com#old-session"
        state.participants["remote-a@example.com#remote-session"] = Participant(
            id: "remote-a@example.com#remote-session",
            displayName: "Remote A"
        )
        state.participants["remote-b@example.com#remote-session"] = Participant(
            id: "remote-b@example.com#remote-session",
            displayName: "Remote B"
        )

        XCTAssertEqual(state.resolvedViewMode, .tiled)
        XCTAssertNil(state.spotlightUserId)
        XCTAssertEqual(state.visibleGridUserIds, [
            "local@example.com#local-session",
            "remote-a@example.com#remote-session",
            "remote-b@example.com#remote-session"
        ])
    }

    @MainActor
    func testStaleWebinarSpeakerDoesNotForceAttendeeSpotlightLayout() throws {
        let state = MeetingState(userId: "attendee@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "attendee@example.com"
        state.connectionState = ConnectionState.joined
        state.webinarRole = "attendee"
        state.webinarSpeakerUserId = "missing@example.com#old-session"

        XCTAssertEqual(state.resolvedViewMode, .tiled)
        XCTAssertNil(state.spotlightUserId)
        XCTAssertEqual(state.visibleGridUserIds, ["attendee@example.com#local-session"])
    }

    @MainActor
    func testWebinarSpeakerAliasResolvesToRenderableAttendeeSpotlightLayout() throws {
        let state = MeetingState(userId: "attendee@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "attendee@example.com"
        state.connectionState = ConnectionState.joined
        state.webinarRole = "attendee"
        state.webinarSpeakerUserId = "speaker@example.com"
        state.participants["speaker@example.com#web-session"] = Participant(
            id: "speaker@example.com#web-session",
            displayName: "Speaker",
            isCameraOff: false
        )

        XCTAssertEqual(state.resolvedViewMode, .spotlight)
        XCTAssertEqual(state.spotlightUserId, "speaker@example.com#web-session")
    }

    @MainActor
    func testPinnedParticipantAliasResolvesToRenderableTileId() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.spotlight
        state.pinnedUserId = "remote@example.com"
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote"
        )

        XCTAssertEqual(state.spotlightUserId, "remote@example.com#remote-session")
    }

    @MainActor
    func testTogglePinClearsAliasedPinnedParticipant() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.viewMode = MeetingViewMode.spotlight
        viewModel.state.pinnedUserId = "remote@example.com"
        viewModel.state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote"
        )

        viewModel.togglePin("remote@example.com#remote-session")

        XCTAssertNil(viewModel.state.pinnedUserId)
        XCTAssertEqual(viewModel.state.viewMode, .auto)
    }

    @MainActor
    func testPinnedBaseIdKeepsVideoLessSessionParticipantVisible() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.hideTilesWithoutVideo = true
        state.pinnedUserId = "remote@example.com"
        state.participants["remote@example.com#remote-session"] = Participant(
            id: "remote@example.com#remote-session",
            displayName: "Remote",
            isMuted: true,
            isCameraOff: true
        )

        XCTAssertTrue(state.isPinnedParticipant("remote@example.com#remote-session"))
        XCTAssertEqual(state.visibleTileParticipants.map(\.id), ["remote@example.com#remote-session"])
        XCTAssertEqual(state.visibleGridUserIds, ["remote@example.com#remote-session"])
    }

    @MainActor
    func testStaleScreenShareIdDoesNotForcePresentationSurface() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.activeScreenShareUserId = "missing@example.com#old-session"

        XCTAssertFalse(state.hasActiveScreenShare)
        XCTAssertFalse(state.hasActiveRemoteScreenShare)
        XCTAssertNil(state.presentationScreenShareUserId)
        XCTAssertFalse(state.hasPresentationSurface)
        XCTAssertEqual(state.visibleGridUserIds, ["local@example.com#local-session"])
    }

    @MainActor
    func testLocalScreenShareIdRequiresActiveLocalSharing() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.activeScreenShareUserId = state.userId
        state.isScreenSharing = false

        XCTAssertFalse(state.hasActiveScreenShare)
        XCTAssertNil(state.presentationScreenShareUserId)

        state.isScreenSharing = true

        XCTAssertTrue(state.hasActiveScreenShare)
        XCTAssertFalse(state.hasActiveRemoteScreenShare)
        XCTAssertEqual(state.presentationScreenShareUserId, "local@example.com#local-session")
        XCTAssertTrue(state.hasPresentationSurface)
    }

    @MainActor
    func testRemoteScreenShareAliasRequiresActivePresenter() throws {
        let state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "local@example.com"
        state.connectionState = ConnectionState.joined
        state.activeScreenShareUserId = "presenter@example.com"
        state.participants["presenter@example.com#web-session"] = Participant(
            id: "presenter@example.com#web-session",
            displayName: "Presenter",
            isScreenSharing: false
        )

        XCTAssertFalse(state.hasActiveScreenShare)

        state.participants["presenter@example.com#web-session"]?.isScreenSharing = true

        XCTAssertTrue(state.hasActiveScreenShare)
        XCTAssertTrue(state.hasActiveRemoteScreenShare)
        XCTAssertEqual(state.presentationScreenShareUserId, "presenter@example.com#web-session")
        XCTAssertTrue(state.hasPresentationSurface)
    }

    func testParticipantScreenShareDisplayPolicyRequiresStateOrProducerEvidence() throws {
        XCTAssertFalse(ParticipantScreenShareDisplayPolicy.isScreenSharing(
            participantFlag: false,
            screenShareProducerId: nil
        ))
        XCTAssertFalse(ParticipantScreenShareDisplayPolicy.isScreenSharing(
            participantFlag: false,
            screenShareProducerId: "   "
        ))
        XCTAssertTrue(ParticipantScreenShareDisplayPolicy.isScreenSharing(
            participantFlag: true,
            screenShareProducerId: nil
        ))
        XCTAssertTrue(ParticipantScreenShareDisplayPolicy.isScreenSharing(
            participantFlag: false,
            screenShareProducerId: "screen-producer-1"
        ))
    }

    func testParticipantProducerActionPolicyRequiresConcreteProducerId() throws {
        XCTAssertFalse(ParticipantProducerActionPolicy.hasProducer(nil))
        XCTAssertFalse(ParticipantProducerActionPolicy.hasProducer("   "))
        XCTAssertTrue(ParticipantProducerActionPolicy.hasProducer(" producer-1 "))
        XCTAssertNil(ParticipantProducerActionPolicy.normalizedProducerId(nil))
        XCTAssertNil(ParticipantProducerActionPolicy.normalizedProducerId("   "))
        XCTAssertEqual(ParticipantProducerActionPolicy.normalizedProducerId(" producer-1 "), "producer-1")
    }

    func testParticipantSheetAdminActionPolicyRejectsStaleCompletions() throws {
        XCTAssertTrue(ParticipantSheetAdminActionPolicy.shouldApplyCompletion(
            generation: 2,
            currentGeneration: 2,
            actionRoomId: " room-a ",
            currentRoomId: "room-a"
        ))
        XCTAssertTrue(ParticipantSheetAdminActionPolicy.shouldApplyCompletion(
            generation: 2,
            currentGeneration: 2,
            actionRoomId: " Room-A ",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(ParticipantSheetAdminActionPolicy.shouldApplyCompletion(
            generation: 1,
            currentGeneration: 2,
            actionRoomId: "room-a",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(ParticipantSheetAdminActionPolicy.shouldApplyCompletion(
            generation: 2,
            currentGeneration: 2,
            actionRoomId: "room-a",
            currentRoomId: "room-b"
        ))
        XCTAssertFalse(ParticipantSheetAdminActionPolicy.shouldApplyCompletion(
            generation: 2,
            currentGeneration: 2,
            actionRoomId: "   ",
            currentRoomId: "room-a"
        ))
    }

    func testAdminControlsActionPolicyRejectsStaleCompletions() throws {
        XCTAssertTrue(AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: " room-a ",
            currentRoomId: "room-a"
        ))
        XCTAssertTrue(AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: " Room-A ",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: 3,
            currentGeneration: 4,
            actionRoomId: "room-a",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: "room-a",
            currentRoomId: "room-b"
        ))
        XCTAssertFalse(AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: "",
            currentRoomId: "room-a"
        ))
    }

    @MainActor
    func testSameAccountDifferentSessionRendersAsRemoteParticipant() throws {
        let state = MeetingState(userId: "alex@example.com#local-session", sessionId: "local-session")
        state.sfuUserId = "alex@example.com"
        state.displayName = "Alex Local"
        state.connectionState = ConnectionState.joined
        state.viewMode = MeetingViewMode.tiled
        state.selfViewMode = MeetingSelfViewMode.floating

        let remoteSessionId = "alex@example.com#remote-session"
        state.participants[remoteSessionId] = Participant(
            id: remoteSessionId,
            displayName: "Alex Remote"
        )

        XCTAssertTrue(state.isRemoteParticipantUserId(remoteSessionId))
        XCTAssertEqual(state.participantCount, 2)
        XCTAssertEqual(state.visibleGridUserIds, [remoteSessionId])
        XCTAssertEqual(state.displayName(for: remoteSessionId), "Alex Remote")
    }

    @MainActor
    func testTokenIdentitySwapPreservesRemoteSameAccountSession() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "alex@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "alex@example.com"
        viewModel.state.displayName = "Alex Native"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.viewMode = MeetingViewMode.tiled
        viewModel.state.selfViewMode = MeetingSelfViewMode.floating

        let remoteSessionId = "alex@example.com#web-session"
        viewModel.state.participants[remoteSessionId] = Participant(
            id: remoteSessionId,
            displayName: "Alex Web"
        )

        viewModel.applyLocalJoinIdentity(
            SfuJoinIdentity(
                userKey: "alex@example.com",
                userId: "alex@example.com#native-session"
            ),
            isHostHint: false
        )

        XCTAssertEqual(viewModel.state.userId, "alex@example.com#native-session")
        XCTAssertEqual(viewModel.state.sfuUserId, "alex@example.com")
        XCTAssertEqual(viewModel.state.participants[remoteSessionId]?.displayName, "Alex Web")
        XCTAssertEqual(viewModel.state.participantCount, 2)
        XCTAssertEqual(viewModel.state.visibleGridUserIds, [remoteSessionId])
    }

    @MainActor
    func testDepartedSameAccountSessionDoesNotBlockNewRemoteSession() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.connectionState = ConnectionState.joined

        let oldSessionId = "alex@example.com#old-session"
        let newSessionId = "alex@example.com#new-session"

        XCTAssertTrue(viewModel.markRemoteParticipantPresent(oldSessionId))
        viewModel.markRemoteParticipantDeparted(oldSessionId)

        XCTAssertTrue(viewModel.shouldIgnoreDepartedParticipant(oldSessionId))
        XCTAssertFalse(viewModel.shouldIgnoreDepartedParticipant(newSessionId))

        XCTAssertTrue(viewModel.markRemoteParticipantPresent(newSessionId))
        XCTAssertEqual(viewModel.state.participants[newSessionId]?.id, newSessionId)
        XCTAssertTrue(viewModel.state.isRemoteParticipantUserId(newSessionId))
    }

    @MainActor
    func testDelayedStableLeaveCleanupDoesNotRemoveQuickSessionRejoin() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined

        let stableRemoteId = "alex@example.com"
        let newSessionId = "alex@example.com#new-session"
        viewModel.state.participants[stableRemoteId] = Participant(
            id: stableRemoteId,
            displayName: "Alex"
        )

        viewModel.socketManager.onUserLeft?(UserLeftNotification(
            userId: stableRemoteId,
            roomId: "room-a"
        ))
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(viewModel.state.participants[stableRemoteId]?.isLeaving, true)

        viewModel.handleProducerState(ProducerInfo(
            producerId: "new-webcam",
            producerUserId: newSessionId,
            kind: "video",
            type: ProducerType.webcam.rawValue,
            paused: false,
            roomId: "room-a"
        ))
        XCTAssertEqual(viewModel.state.participants[newSessionId]?.id, newSessionId)
        XCTAssertEqual(viewModel.state.participants[newSessionId]?.isLeaving, false)

        try? await Task.sleep(nanoseconds: 250_000_000)

        XCTAssertNil(viewModel.state.participants[stableRemoteId])
        XCTAssertEqual(viewModel.state.participants[newSessionId]?.id, newSessionId)
        XCTAssertEqual(viewModel.state.visibleGridUserIds, [newSessionId])
    }

    @MainActor
    func testDepartedExactSessionCanBeMarkedPresentAgain() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.connectionState = ConnectionState.joined

        let remoteSessionId = "alex@example.com#remote-session"

        XCTAssertTrue(viewModel.markRemoteParticipantPresent(remoteSessionId))
        viewModel.markRemoteParticipantDeparted(remoteSessionId)
        XCTAssertTrue(viewModel.shouldIgnoreDepartedParticipant(remoteSessionId))

        XCTAssertTrue(viewModel.markRemoteParticipantPresent(remoteSessionId))
        XCTAssertFalse(viewModel.shouldIgnoreDepartedParticipant(remoteSessionId))
        XCTAssertEqual(viewModel.state.visibleGridUserIds, [remoteSessionId])
    }

    @MainActor
    func testPreAckBrowserStateReplaysAfterJoinReset() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingBrowserState(BrowserStateNotification(
            active: true,
            url: "https://example.com",
            noVncUrl: "http://127.0.0.1:6080/vnc.html",
            controllerUserId: "host@example.com#host-session",
            roomId: "demo-room"
        ))

        viewModel.state.isBrowserActive = false
        viewModel.state.browserURL = nil
        viewModel.state.browserNoVncURL = nil
        viewModel.state.browserControllerUserId = nil
        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertTrue(viewModel.state.isBrowserActive)
        XCTAssertEqual(viewModel.state.browserURL, "https://example.com")
        XCTAssertEqual(viewModel.state.browserNoVncURL, "http://127.0.0.1:6080/vnc.html")
        XCTAssertEqual(viewModel.state.browserControllerUserId, "host@example.com#host-session")
    }

    @MainActor
    func testStalePreAckBrowserCloseDoesNotReplaceCurrentPendingBrowserState() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingBrowserState(BrowserStateNotification(
            active: true,
            url: "https://current.example",
            noVncUrl: "http://127.0.0.1:6080/vnc.html",
            controllerUserId: "host@example.com#host-session",
            roomId: "demo-room"
        ))
        viewModel.bufferPendingBrowserClosed(BrowserClosedNotification(
            closedBy: nil,
            roomId: "old-room"
        ))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertTrue(viewModel.state.isBrowserActive)
        XCTAssertEqual(viewModel.state.browserURL, "https://current.example")
        XCTAssertEqual(viewModel.state.browserNoVncURL, "http://127.0.0.1:6080/vnc.html")
        XCTAssertEqual(viewModel.state.browserControllerUserId, "host@example.com#host-session")
    }

    @MainActor
    func testPreAckBrowserClosedReplaysOnlyForCurrentRoom() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.isBrowserActive = true
        viewModel.state.browserURL = "https://current.example"
        viewModel.state.browserNoVncURL = "http://127.0.0.1:6080/vnc.html"
        viewModel.state.browserControllerUserId = "host@example.com#host-session"

        viewModel.bufferPendingBrowserClosed(BrowserClosedNotification(
            closedBy: nil,
            roomId: "old-room"
        ))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertTrue(viewModel.state.isBrowserActive)
        XCTAssertEqual(viewModel.state.browserURL, "https://current.example")
        XCTAssertEqual(viewModel.state.browserNoVncURL, "http://127.0.0.1:6080/vnc.html")
        XCTAssertEqual(viewModel.state.browserControllerUserId, "host@example.com#host-session")

        viewModel.bufferPendingBrowserClosed(BrowserClosedNotification(
            closedBy: nil,
            roomId: "demo-room"
        ))

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertFalse(viewModel.state.isBrowserActive)
        XCTAssertNil(viewModel.state.browserURL)
        XCTAssertNil(viewModel.state.browserNoVncURL)
        XCTAssertNil(viewModel.state.browserControllerUserId)
    }

    @MainActor
    func testPreAckConfigSnapshotsReplayAfterJoinReset() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingMeetingConfigSnapshot(MeetingConfigSnapshot(
            roomId: "demo-room",
            requiresInviteCode: true
        ))
        viewModel.bufferPendingWebinarConfigSnapshot(WebinarConfigSnapshot(
            roomId: "demo-room",
            enabled: true,
            publicAccess: false,
            locked: true,
            maxAttendees: 300,
            attendeeCount: 9,
            requiresInviteCode: true,
            linkSlug: "demo-webinar",
            feedMode: "manual"
        ))

        viewModel.state.meetingRequiresInviteCode = false
        viewModel.state.isWebinarEnabled = false
        viewModel.state.isWebinarPublicAccess = true
        viewModel.state.isWebinarLocked = false
        viewModel.state.webinarMaxAttendees = 500
        viewModel.state.webinarAttendeeCount = 0
        viewModel.state.webinarRequiresInviteCode = false
        viewModel.state.webinarLinkSlug = nil
        viewModel.state.webinarLinkURL = nil
        viewModel.state.webinarFeedMode = "active-speaker"
        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertTrue(viewModel.state.meetingRequiresInviteCode)
        XCTAssertTrue(viewModel.state.isWebinarEnabled)
        XCTAssertFalse(viewModel.state.isWebinarPublicAccess)
        XCTAssertTrue(viewModel.state.isWebinarLocked)
        XCTAssertEqual(viewModel.state.webinarMaxAttendees, 300)
        XCTAssertEqual(viewModel.state.webinarAttendeeCount, 9)
        XCTAssertTrue(viewModel.state.webinarRequiresInviteCode)
        XCTAssertEqual(viewModel.state.webinarLinkSlug, "demo-webinar")
        XCTAssertEqual(viewModel.state.webinarLinkURL, "https://conclave.acmvit.in/w/demo-webinar")
        XCTAssertEqual(viewModel.state.webinarFeedMode, "manual")
    }

    @MainActor
    func testStalePreAckConfigSnapshotsDoNotReplaceCurrentPendingConfig() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingMeetingConfigSnapshot(MeetingConfigSnapshot(
            roomId: "demo-room",
            requiresInviteCode: true
        ))
        viewModel.bufferPendingWebinarConfigSnapshot(WebinarConfigSnapshot(
            roomId: "demo-room",
            enabled: true,
            publicAccess: false,
            locked: true,
            maxAttendees: 250,
            attendeeCount: 12,
            requiresInviteCode: true,
            linkSlug: "current-webinar",
            feedMode: "manual"
        ))
        viewModel.bufferPendingMeetingConfigSnapshot(MeetingConfigSnapshot(
            roomId: "old-room",
            requiresInviteCode: false
        ))
        viewModel.bufferPendingWebinarConfigSnapshot(WebinarConfigSnapshot(
            roomId: "old-room",
            enabled: false,
            publicAccess: true,
            locked: false,
            maxAttendees: 500,
            attendeeCount: 0,
            requiresInviteCode: false,
            linkSlug: "old-webinar",
            feedMode: "active-speaker"
        ))

        viewModel.state.meetingRequiresInviteCode = false
        viewModel.state.isWebinarEnabled = false
        viewModel.state.isWebinarPublicAccess = true
        viewModel.state.isWebinarLocked = false
        viewModel.state.webinarMaxAttendees = 500
        viewModel.state.webinarAttendeeCount = 0
        viewModel.state.webinarRequiresInviteCode = false
        viewModel.state.webinarLinkSlug = nil
        viewModel.state.webinarLinkURL = nil
        viewModel.state.webinarFeedMode = "active-speaker"
        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertTrue(viewModel.state.meetingRequiresInviteCode)
        XCTAssertTrue(viewModel.state.isWebinarEnabled)
        XCTAssertFalse(viewModel.state.isWebinarPublicAccess)
        XCTAssertTrue(viewModel.state.isWebinarLocked)
        XCTAssertEqual(viewModel.state.webinarMaxAttendees, 250)
        XCTAssertEqual(viewModel.state.webinarAttendeeCount, 12)
        XCTAssertTrue(viewModel.state.webinarRequiresInviteCode)
        XCTAssertEqual(viewModel.state.webinarLinkSlug, "current-webinar")
        XCTAssertEqual(viewModel.state.webinarLinkURL, "https://conclave.acmvit.in/w/current-webinar")
        XCTAssertEqual(viewModel.state.webinarFeedMode, "manual")
    }

    @MainActor
    func testStalePreAckAppsStateDoesNotReplaceCurrentPendingAppsState() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining

        viewModel.bufferPendingAppsState(AppsStateNotification(
            activeAppId: "current-app",
            locked: true,
            roomId: "demo-room"
        ))
        viewModel.bufferPendingAppsState(AppsStateNotification(
            activeAppId: "old-app",
            locked: false,
            roomId: "old-room"
        ))

        viewModel.state.activeAppId = nil
        viewModel.state.isAppsLocked = false
        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.activeAppId, "current-app")
        XCTAssertTrue(viewModel.state.isAppsLocked)
    }

    @MainActor
    func testStalePreAckAppYjsUpdatesDoNotEvictCurrentPendingUpdate() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.activeAppId = "whiteboard"

        let currentUpdate = Data([0x01, 0x02])
        viewModel.appendPendingAppsYjsUpdate(AppsYjsUpdateNotification(
            appId: "whiteboard",
            update: currentUpdate,
            roomId: "demo-room"
        ))
        for index in 0..<70 {
            viewModel.appendPendingAppsYjsUpdate(AppsYjsUpdateNotification(
                appId: "whiteboard",
                update: Data([UInt8(index)]),
                roomId: "old-room"
            ))
        }

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.appId, "whiteboard")
        XCTAssertEqual(viewModel.state.latestAppYjsUpdate?.data, currentUpdate)
        XCTAssertEqual(viewModel.state.appYjsUpdateSequence, 1)
    }

    @MainActor
    func testStalePreAckAppAwarenessUpdatesDoNotEvictCurrentPendingUpdate() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.activeAppId = "whiteboard"

        let currentUpdate = Data([0x08, 0x09])
        viewModel.appendPendingAppsAwarenessUpdate(AppsAwarenessNotification(
            appId: "whiteboard",
            awarenessUpdate: currentUpdate,
            clientId: 12,
            roomId: "demo-room"
        ))
        for index in 0..<70 {
            viewModel.appendPendingAppsAwarenessUpdate(AppsAwarenessNotification(
                appId: "whiteboard",
                awarenessUpdate: Data([UInt8(index)]),
                clientId: index,
                roomId: "old-room"
            ))
        }

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.latestAppAwarenessUpdate?.appId, "whiteboard")
        XCTAssertEqual(viewModel.state.latestAppAwarenessUpdate?.data, currentUpdate)
        XCTAssertEqual(viewModel.state.latestAppAwarenessUpdate?.clientId, 12)
        XCTAssertEqual(viewModel.state.appAwarenessUpdateSequence, 1)
    }

    @MainActor
    func testStalePreAckWebinarFeedDoesNotReplaceCurrentPendingFeed() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.webinarRole = "attendee"

        let speakerUserId = "speaker@example.com#speaker-session"
        viewModel.bufferPendingWebinarFeedChanged(WebinarFeedChangedNotification(
            roomId: "demo-room",
            speakerUserId: speakerUserId,
            producers: [
                ProducerInfo(
                    producerId: "current-video-producer",
                    producerUserId: speakerUserId,
                    kind: "video",
                    type: ProducerType.webcam.rawValue,
                    paused: false,
                    roomId: "demo-room"
                )
            ]
        ))
        viewModel.bufferPendingWebinarFeedChanged(WebinarFeedChangedNotification(
            roomId: "old-room",
            speakerUserId: "old@example.com#old-session",
            producers: []
        ))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.webinarSpeakerUserId, speakerUserId)
        XCTAssertEqual(viewModel.state.participants[speakerUserId]?.id, speakerUserId)
    }

    @MainActor
    func testWebinarFeedKeepsAliasedActiveScreenSharePresenter() async throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "demo-room"
        viewModel.state.connectionState = ConnectionState.joining
        viewModel.state.webinarRole = "attendee"

        let presenterStateId = "presenter@example.com#web-session"
        viewModel.state.activeScreenShareUserId = presenterStateId
        viewModel.state.participants[presenterStateId] = Participant(
            id: presenterStateId,
            displayName: "Presenter",
            isScreenSharing: true
        )
        viewModel.bufferPendingWebinarFeedChanged(WebinarFeedChangedNotification(
            roomId: "demo-room",
            speakerUserId: "presenter@example.com",
            producers: [
                ProducerInfo(
                    producerId: "screen-producer",
                    producerUserId: "presenter@example.com",
                    kind: "video",
                    type: ProducerType.screen.rawValue,
                    paused: false,
                    roomId: "demo-room"
                )
            ]
        ))

        viewModel.state.connectionState = ConnectionState.joined

        await replayPendingPreAckRoomEvents(on: viewModel, includeDeferredRoomState: true)

        XCTAssertEqual(viewModel.state.activeScreenShareUserId, presenterStateId)
        XCTAssertTrue(viewModel.state.participants[presenterStateId]?.isScreenSharing == true)
        XCTAssertEqual(viewModel.state.presentationScreenShareUserId, presenterStateId)
    }

    func testNativeCookieSupportStoresAndAttachesAuthCookies() throws {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.254:39999/api/auth/sign-in/social"))
        let joinURL = try XCTUnwrap(URL(string: "http://127.0.0.254:39999/api/sfu/join"))
        let cookieName = "better-auth.session_token"
        let storage = HTTPCookieStorage.shared

        func clearTestCookies() {
            for cookie in storage.cookies ?? [] where cookie.domain == "127.0.0.254" && cookie.name == cookieName {
                storage.deleteCookie(cookie)
            }
        }

        clearTestCookies()
        defer { clearTestCookies() }

        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [
                "Set-Cookie": "\(cookieName)=native-session; Path=/; HttpOnly; SameSite=Lax"
            ]
        ))

        NativeCookieSupport.storeCookies(from: response, url: url)

        var request = URLRequest(url: joinURL)
        NativeCookieSupport.attachCookies(to: &request)

        let cookieHeader = try XCTUnwrap(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertTrue(cookieHeader.contains("\(cookieName)=native-session"))
    }

    func testNativeAuthCookiePolicyMatchesApexAndSubdomainHostsBothWays() throws {
        XCTAssertTrue(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: "conclave.acmvit.in",
            targetHost: "www.conclave.acmvit.in"
        ))
        XCTAssertTrue(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: "www.conclave.acmvit.in",
            targetHost: "conclave.acmvit.in"
        ))
        XCTAssertTrue(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: ".conclave.acmvit.in",
            targetHost: "WWW.CONCLAVE.ACMVIT.IN"
        ))
        XCTAssertTrue(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: nil,
            targetHost: "conclave.acmvit.in"
        ))

        XCTAssertFalse(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: "evilconclave.acmvit.in",
            targetHost: "conclave.acmvit.in"
        ))
        XCTAssertFalse(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: "example.com",
            targetHost: "conclave.acmvit.in"
        ))
        XCTAssertFalse(NativeAuthCookiePolicy.cookieDomainMatchesHost(
            cookieDomain: "conclave.acmvit.in",
            targetHost: nil
        ))
    }

    func testNativeAuthCookiePolicyMatchesAuthCookieNamesCaseInsensitively() throws {
        XCTAssertTrue(NativeAuthCookiePolicy.isAuthCookieName("__Secure-Better-Auth.Session_Token"))
        XCTAssertTrue(NativeAuthCookiePolicy.isAuthCookieName("native_session_id"))
        XCTAssertTrue(NativeAuthCookiePolicy.isAuthCookieName("AUTH_CALLBACK"))
        XCTAssertFalse(NativeAuthCookiePolicy.isAuthCookieName("theme"))
    }

    func testNativeAuthProviderDecoderAcceptsWebProviderArray() throws {
        let providers = try NativeAuthService.decodeEnabledProviders(from: Data("""
        { "providers": ["google", "apple", "roblox", "vercel"] }
        """.utf8))

        XCTAssertEqual(providers, Set([NativeAuthProvider.google, NativeAuthProvider.apple]))
    }

    func testNativeAuthProviderDecoderAcceptsProviderMap() throws {
        let providers = try NativeAuthService.decodeEnabledProviders(from: Data("""
        { "providers": { "google": {}, "apple": {}, "roblox": {} } }
        """.utf8))

        XCTAssertEqual(providers, Set([NativeAuthProvider.google, NativeAuthProvider.apple]))
    }

    func testNativeAuthProviderDecoderAcceptsProviderObjects() throws {
        let providers = try NativeAuthService.decodeEnabledProviders(from: Data("""
        {
          "providers": [
            { "id": " Google ", "name": "Google" },
            { "providerId": "Apple", "name": "Apple" },
            { "id": "roblox", "name": "Roblox" }
          ]
        }
        """.utf8))

        XCTAssertEqual(providers, Set([NativeAuthProvider.google, NativeAuthProvider.apple]))
    }

    func testNativeAuthProviderDecoderAcceptsTopLevelProviderArray() throws {
        let providers = try NativeAuthService.decodeEnabledProviders(from: Data("""
        ["google", "apple", "vercel"]
        """.utf8))

        XCTAssertEqual(providers, Set([NativeAuthProvider.google, NativeAuthProvider.apple]))
    }

    func testDecodeType() throws {
        let resourceURL: URL = try XCTUnwrap(Bundle.module.url(forResource: "TestData", withExtension: "json"))
        let testData = try JSONDecoder().decode(TestData.self, from: Data(contentsOf: resourceURL))
        XCTAssertEqual("Conclave", testData.testModuleName)
    }

    func testPortraitTwoPersonTileLayoutUsesTwoColumns() throws {
        let layout = computeOptimalTileLayout(
            participantCount: 2,
            containerWidth: 393,
            containerHeight: 640,
            spacing: 12,
            padding: 16
        )

        XCTAssertEqual(layout.columns, 2)
        XCTAssertEqual(layout.rows, 1)
        XCTAssertGreaterThan(layout.tileWidth, 0)
        XCTAssertGreaterThan(layout.tileHeight, layout.tileWidth)
    }

    func testPortraitSingleVisibleRemoteTileKeepsStageInsideBounds() throws {
        let layout = computeOptimalTileLayout(
            participantCount: 1,
            containerWidth: 393,
            containerHeight: 640,
            spacing: 12,
            padding: 16
        )

        XCTAssertEqual(layout.columns, 1)
        XCTAssertEqual(layout.rows, 1)
        XCTAssertEqual(layout.tileHeight, layout.tileWidth, accuracy: 0.5)
    }

    func testMeetingGridSizingClampsTinyContainerMeasurements() throws {
        let layout = computeOptimalTileLayout(
            participantCount: 4,
            containerWidth: 20,
            containerHeight: 18,
            spacing: 12,
            padding: 16
        )
        let scrollTileWidth = MeetingGridSizing.scrollTileWidth(
            containerWidth: 20,
            columnCount: 2,
            spacing: 12,
            padding: 16
        )
        let nonFiniteScrollTileWidth = MeetingGridSizing.scrollTileWidth(
            containerWidth: CGFloat.nan,
            columnCount: 2,
            spacing: 12,
            padding: 16
        )

        XCTAssertTrue(layout.tileWidth.isFinite)
        XCTAssertTrue(layout.tileHeight.isFinite)
        XCTAssertGreaterThanOrEqual(layout.tileWidth, 1)
        XCTAssertGreaterThanOrEqual(layout.tileHeight, 1)
        XCTAssertEqual(scrollTileWidth, 1, accuracy: 0.001)
        XCTAssertEqual(nonFiniteScrollTileWidth, 1, accuracy: 0.001)
    }

    func testGridLayoutCentersPartialRowsInsideBounds() throws {
        let layout = computeGridLayout(
            count: 5,
            width: 900,
            height: 520,
            options: GridLayoutOptions(gap: 12, maxCols: 4)
        )

        XCTAssertEqual(layout.positions.count, 5)
        for position in layout.positions {
            XCTAssertGreaterThanOrEqual(position.x, layout.offsetX)
            XCTAssertGreaterThanOrEqual(position.y, layout.offsetY)
            XCTAssertLessThanOrEqual(position.x + position.width, layout.offsetX + layout.contentWidth)
            XCTAssertLessThanOrEqual(position.y + position.height, layout.offsetY + layout.contentHeight)
        }

        let finalRow = layout.positions.filter { $0.row == layout.rows - 1 }
        let finalRowWidth = finalRow.reduce(CGFloat(0)) { partial, position in
            max(partial, position.x + position.width)
        } - (finalRow.map(\.x).min() ?? 0)
        let finalRowLeadingInset = (finalRow.map(\.x).min() ?? 0) - layout.offsetX
        let finalRowTrailingInset = layout.offsetX + layout.contentWidth -
            (finalRow.reduce(CGFloat(0)) { partial, position in max(partial, position.x + position.width) })
        let insetDifference = abs(finalRowLeadingInset - finalRowTrailingInset)

        XCTAssertGreaterThan(finalRow.count, 0)
        XCTAssertGreaterThan(finalRowWidth, 0)
        XCTAssertLessThanOrEqual(insetDifference, 1)
    }

    func testGridLayoutClampsInvalidOptionsBeforeLayoutMath() throws {
        let layout = computeGridLayout(
            count: 3,
            width: 640,
            height: 360,
            options: GridLayoutOptions(gap: CGFloat.nan, maxCols: 0, maxTilesPerPage: 0, targetAspect: CGFloat.infinity)
        )

        XCTAssertEqual(layout.pages, 3)
        XCTAssertEqual(layout.perPage, 1)
        XCTAssertEqual(layout.positions.count, 1)
        XCTAssertTrue(layout.tileWidth.isFinite)
        XCTAssertTrue(layout.tileHeight.isFinite)
        XCTAssertTrue(layout.contentWidth.isFinite)
        XCTAssertTrue(layout.contentHeight.isFinite)
        XCTAssertTrue(layout.positions.allSatisfy { position in
            position.x.isFinite && position.y.isFinite && position.width.isFinite && position.height.isFinite
        })
        XCTAssertGreaterThan(layout.tileWidth, 0)
        XCTAssertGreaterThan(layout.tileHeight, 0)
    }

    func testMeetingInviteFeedbackPolicyKeepsGenerationGuards() throws {
        XCTAssertEqual(MeetingInviteFeedbackPolicy.copyFeedbackNanoseconds, 1_500_000_000)
        XCTAssertEqual(MeetingInviteFeedbackPolicy.shareFeedbackNanoseconds, 2_400_000_000)
        XCTAssertTrue(MeetingInviteFeedbackPolicy.shouldApply(generation: 3, currentGeneration: 3))
        XCTAssertFalse(MeetingInviteFeedbackPolicy.shouldApply(generation: 3, currentGeneration: 4))
    }

    func testSettingsCopyFeedbackPolicyKeepsWebinarLinkGenerationGuard() throws {
        XCTAssertEqual(SettingsTimingPolicy.webinarLinkFeedbackNanoseconds, 1_600_000_000)
        XCTAssertTrue(SettingsTimingPolicy.shouldApply(generation: 2, currentGeneration: 2))
        XCTAssertFalse(SettingsTimingPolicy.shouldApply(generation: 2, currentGeneration: 3))
    }

    func testSettingsRefreshPolicyRejectsStaleScheduledRefreshes() throws {
        XCTAssertTrue(SettingsRefreshPolicy.shouldApplyScheduledRefresh(
            scheduledPage: SettingsSheetPage.webinar,
            currentPage: SettingsSheetPage.webinar,
            scheduledRoomId: "room-a",
            currentRoomId: "room-a",
            bodyReady: true
        ))
        XCTAssertTrue(SettingsRefreshPolicy.shouldApplyScheduledRefresh(
            scheduledPage: SettingsSheetPage.webinar,
            currentPage: SettingsSheetPage.webinar,
            scheduledRoomId: " Room-A ",
            currentRoomId: "room-a",
            bodyReady: true
        ))
        XCTAssertFalse(SettingsRefreshPolicy.shouldApplyScheduledRefresh(
            scheduledPage: SettingsSheetPage.webinar,
            currentPage: SettingsSheetPage.room,
            scheduledRoomId: "room-a",
            currentRoomId: "room-a",
            bodyReady: true
        ))
        XCTAssertFalse(SettingsRefreshPolicy.shouldApplyScheduledRefresh(
            scheduledPage: SettingsSheetPage.webinar,
            currentPage: SettingsSheetPage.webinar,
            scheduledRoomId: "room-a",
            currentRoomId: "room-b",
            bodyReady: true
        ))
        XCTAssertFalse(SettingsRefreshPolicy.shouldApplyScheduledRefresh(
            scheduledPage: SettingsSheetPage.webinar,
            currentPage: SettingsSheetPage.webinar,
            scheduledRoomId: "room-a",
            currentRoomId: "room-a",
            bodyReady: false
        ))
    }

    func testSettingsSignOutCompletionPolicyRequiresCurrentGenerationAndRoom() throws {
        XCTAssertTrue(SettingsSignOutCompletionPolicy.shouldApply(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: "room-a",
            currentRoomId: "room-a"
        ))
        XCTAssertTrue(SettingsSignOutCompletionPolicy.shouldApply(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: " Room-A ",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(SettingsSignOutCompletionPolicy.shouldApply(
            generation: 4,
            currentGeneration: 5,
            actionRoomId: "room-a",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(SettingsSignOutCompletionPolicy.shouldApply(
            generation: 4,
            currentGeneration: 4,
            actionRoomId: "room-a",
            currentRoomId: "room-b"
        ))
    }

    func testSettingsDisplayNameAutoSavePolicyRequiresJoinedDistinctName() throws {
        XCTAssertTrue(SettingsDisplayNameAutoSavePolicy.canSave(
            "New Name",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.joined,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            " Old Name ",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.joined,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            "Old   Name",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.joined,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            String(repeating: "A", count: NativeDisplayNameNormalizer.maxLength) + "overflow",
            currentDisplayName: String(repeating: "A", count: NativeDisplayNameNormalizer.maxLength),
            connectionState: ConnectionState.joined,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            "   ",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.joined,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            "New Name",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.reconnecting,
            isWebinarAttendee: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.canSave(
            "New Name",
            currentDisplayName: "Old Name",
            connectionState: ConnectionState.joined,
            isWebinarAttendee: true
        ))
    }

    func testSettingsDisplayNameAutoSavePolicyRejectsStaleRoomFlushes() throws {
        XCTAssertTrue(SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(
            actionRoomId: "room-a",
            currentRoomId: "room-a"
        ))
        XCTAssertTrue(SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(
            actionRoomId: " Room-A ",
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(
            actionRoomId: "room-a",
            currentRoomId: "room-b"
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(
            actionRoomId: nil,
            currentRoomId: "room-a"
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldApplyForRoom(
            actionRoomId: "   ",
            currentRoomId: "room-a"
        ))
    }

    func testSettingsDisplayNameInputSyncWaitsForIdleAutosaveState() throws {
        XCTAssertTrue(SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: false,
            hasPendingAutoSave: false,
            hasLocalSavableDraft: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: true,
            hasPendingAutoSave: false,
            hasLocalSavableDraft: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: false,
            hasPendingAutoSave: true,
            hasLocalSavableDraft: false
        ))
        XCTAssertFalse(SettingsDisplayNameAutoSavePolicy.shouldSyncInputFromServer(
            hasInFlightUpdate: false,
            hasPendingAutoSave: false,
            hasLocalSavableDraft: true
        ))
    }

    func testSettingsDisplayNameAutoSaveClearsDebounceBeforeSubmitting() throws {
        let source = try sourceFileContents("Sources/Conclave/Features/Meeting/SettingsSheetView.swift")
        let guardNeedle = "generation: generation,\n                    currentGeneration: displayNameAutoSaveGeneration\n                  ) else { return }"
        let clearNeedle = "displayNameAutoSaveTask = nil"
        let submitNeedle = "await submitDisplayNameUpdate(pendingName, generation: generation)"

        let guardRange = try XCTUnwrap(source.range(of: guardNeedle))
        let clearRange = try XCTUnwrap(source.range(of: clearNeedle, range: guardRange.upperBound..<source.endIndex))
        let submitRange = try XCTUnwrap(source.range(of: submitNeedle, range: clearRange.upperBound..<source.endIndex))

        XCTAssertLessThan(clearRange.lowerBound, submitRange.lowerBound)
    }

    func testCallAudioRoutePolicyDefaultsToSpeakerOnlyWhenOutputIsNotExternal() throws {
        XCTAssertTrue(CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: nil,
            hasExternalOutputRoute: false
        ))
        XCTAssertFalse(CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: nil,
            hasExternalOutputRoute: true
        ))
    }

    func testCallAudioRoutePolicyHonorsExplicitOutputSelection() throws {
        XCTAssertTrue(CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: " speaker ",
            hasExternalOutputRoute: true
        ))
        XCTAssertFalse(CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: "receiver",
            hasExternalOutputRoute: false
        ))
        XCTAssertFalse(CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: "bluetooth-device-uid",
            hasExternalOutputRoute: false
        ))
    }

    func testAndroidFocusedChatOverlayKeepsComposerClearance() throws {
        let focusedBottomPadding = MeetingChatOverlayLayout.bottomPadding(
            inputFocused: true,
            safeAreaBottom: 0,
            keyboardInset: 0,
            isAndroid: true
        )
        let focusedHeight = MeetingChatOverlayLayout.maxHeight(
            for: 680,
            inputFocused: true,
            isAndroid: true
        )

        XCTAssertEqual(focusedBottomPadding, 12)
        // Full-height docked panel fills the available height.
        XCTAssertEqual(focusedHeight, 680)
    }

    func testAndroidUnfocusedChatDockedPanelUsesSmallBottomInset() throws {
        // The chat is a full-height docked panel that covers the controls, so the
        // composer only needs a small bottom inset (home indicator), not 84pt of
        // clearance for the controls bar.
        XCTAssertEqual(
            MeetingChatOverlayLayout.bottomPadding(
                inputFocused: false,
                safeAreaBottom: 0,
                keyboardInset: 0,
                isAndroid: true
            ),
            12
        )
    }

    func testAndroidChatComposerUsesCompactTouchTargets() throws {
        XCTAssertEqual(ChatComposerLayout.inputHeight(isAndroid: true), 36)
        XCTAssertEqual(ChatComposerLayout.inputVerticalPadding(isAndroid: true), 0)
        XCTAssertEqual(ChatComposerLayout.composerVerticalPadding(isAndroid: true), 4)
        XCTAssertEqual(ChatComposerLayout.composerMinHeight(isAndroid: true), 44)
        XCTAssertLessThan(ChatComposerLayout.composerMinHeight(isAndroid: true), ChatComposerLayout.composerMinHeight(isAndroid: false))
    }

    func testCompactControlsBarFitsNarrowPhoneWidth() throws {
        let availableWidth: CGFloat = 300
        let minimumWidth = MeetingControlsBarLayout.minimumOuterWidth(
            controlButtonCount: 5,
            includesSeparator: true,
            availableWidth: availableWidth,
            isCompact: true
        )

        XCTAssertLessThanOrEqual(minimumWidth, availableWidth)
        XCTAssertLessThanOrEqual(
            MeetingControlsBarLayout.contentMaxWidth(
                availableWidth: availableWidth,
                isCompact: true
            ),
            availableWidth - 24
        )
    }

    func testCompactControlsBarKeepsLargerPhoneWidthCapped() throws {
        XCTAssertEqual(
            MeetingControlsBarLayout.outerMaxWidth(availableWidth: 430, isCompact: true),
            384
        )
        XCTAssertEqual(
            MeetingControlsBarLayout.itemSpacing(availableWidth: 430, isCompact: true),
            8
        )
    }

    func testChatFocusReportPolicyOnlyReportsTransitions() throws {
        XCTAssertTrue(ChatFocusReportPolicy.shouldReport(next: true, lastReported: false))
        XCTAssertFalse(ChatFocusReportPolicy.shouldReport(next: true, lastReported: true))
        XCTAssertTrue(ChatFocusReportPolicy.shouldReport(next: false, lastReported: true))
        XCTAssertFalse(ChatFocusReportPolicy.shouldReport(next: false, lastReported: false))
    }

    func testMeetingKeyboardLayoutUsesContainerBoundsForOverlap() throws {
        XCTAssertEqual(
            MeetingKeyboardLayout.visibleHeight(keyboardMinY: 620, containerMaxY: 760),
            140
        )
        XCTAssertEqual(
            MeetingKeyboardLayout.visibleHeight(keyboardMinY: 900, containerMaxY: 760),
            0
        )
    }

    func testMeetingKeyboardLayoutAvoidsGlobalScreenFallback() throws {
        XCTAssertEqual(
            MeetingKeyboardLayout.containerMaxY(activeWindowMaxY: 760, keyboardFrameMaxY: 844),
            760
        )
        XCTAssertEqual(
            MeetingKeyboardLayout.containerMaxY(activeWindowMaxY: nil, keyboardFrameMaxY: 844),
            844
        )
        XCTAssertEqual(
            MeetingKeyboardLayout.containerMaxY(activeWindowMaxY: 0, keyboardFrameMaxY: -20),
            0
        )
    }

    func testMeetingKeyboardLayoutIgnoresTinyDuplicateHeightChanges() throws {
        XCTAssertFalse(MeetingKeyboardLayout.shouldUpdateVisibleHeight(current: 280, next: 280.25))
        XCTAssertTrue(MeetingKeyboardLayout.shouldUpdateVisibleHeight(current: 280, next: 280.5))
        XCTAssertTrue(MeetingKeyboardLayout.shouldUpdateVisibleHeight(current: 280, next: 0))
    }

    func testChatTimelineScrollPolicyOnlySchedulesForVisibleEntries() throws {
        XCTAssertFalse(ChatTimelineScrollPolicy.shouldScheduleDelayedScroll(entryCount: 0))
        XCTAssertTrue(ChatTimelineScrollPolicy.shouldScheduleDelayedScroll(entryCount: 1))
        XCTAssertEqual(ChatTimelineScrollPolicy.delayedScrollNanoseconds, 160_000_000)
    }

    func testChatTimelineScrollPolicyTracksLatestEntryIdentity() throws {
        XCTAssertFalse(ChatTimelineScrollPolicy.shouldScrollToLatest(
            previousEntryId: nil,
            currentEntryId: nil
        ))
        XCTAssertFalse(ChatTimelineScrollPolicy.shouldScrollToLatest(
            previousEntryId: "m_1",
            currentEntryId: "m_1"
        ))
        XCTAssertTrue(ChatTimelineScrollPolicy.shouldScrollToLatest(
            previousEntryId: "m_1",
            currentEntryId: "m_2"
        ))
        XCTAssertTrue(ChatTimelineScrollPolicy.shouldScrollToLatest(
            previousEntryId: nil,
            currentEntryId: "s_notice"
        ))
    }

    func testCompactPresentationLayoutKeepsFilmstripInsideShortViewport() throws {
        let availableHeight: CGFloat = 360
        let screenShareHeight = PresentationCompactLayout.screenShareHeight(availableHeight: availableHeight)
        let totalHeight = screenShareHeight +
            PresentationCompactLayout.spacing +
            PresentationCompactLayout.stripHeight +
            PresentationCompactLayout.verticalPadding

        XCTAssertLessThanOrEqual(totalHeight, availableHeight)
        XCTAssertEqual(screenShareHeight, 252)
    }

    func testCompactPresentationLayoutKeepsPreferredShareHeightOnNormalViewport() throws {
        let availableHeight: CGFloat = 700
        XCTAssertEqual(
            PresentationCompactLayout.screenShareHeight(availableHeight: availableHeight),
            availableHeight * 0.74,
            accuracy: 0.5
        )
    }

    func testMeetingStageLayoutClampsControlsOverlapHeight() throws {
        XCTAssertEqual(
            MeetingStageLayout.visibleHeight(containerHeight: 720, controlsOverlap: 8),
            712
        )
        XCTAssertEqual(
            MeetingStageLayout.visibleHeight(containerHeight: 6, controlsOverlap: 8),
            0
        )
        XCTAssertEqual(
            MeetingStageLayout.visibleHeight(containerHeight: -20, controlsOverlap: 8),
            0
        )
    }

    func testChatOverlayLayoutFillsAvailableHeight() throws {
        // Docked panel fills the full available height on every platform/state.
        XCTAssertEqual(
            MeetingChatOverlayLayout.maxHeight(for: 180, inputFocused: true, isAndroid: true),
            180
        )
        XCTAssertEqual(
            MeetingChatOverlayLayout.maxHeight(for: 480, inputFocused: false, isAndroid: false),
            480
        )
        XCTAssertEqual(
            MeetingChatOverlayLayout.maxHeight(for: 720, inputFocused: false, isAndroid: false),
            720
        )
    }

    func testChatDockedPanelHeightIsIndependentOfFocus() throws {
        // Height no longer shrinks when the composer is focused — the panel is
        // full-height and the keyboard is handled via imePadding / keyboardInset.
        XCTAssertEqual(
            MeetingChatOverlayLayout.maxHeight(for: 680, inputFocused: true, isAndroid: true),
            680
        )
        XCTAssertEqual(
            MeetingChatOverlayLayout.maxHeight(for: 680, inputFocused: false, isAndroid: true),
            680
        )
    }

    func testAndroidMeetingSheetRevealsBodyImmediately() throws {
        XCTAssertEqual(MeetingSheetView.detentFraction, 0.62)
        XCTAssertEqual(MeetingSheetView.androidDetentFraction, 0.88)
        XCTAssertGreaterThan(MeetingSheetView.androidDetentFraction, MeetingSheetView.detentFraction)
        XCTAssertEqual(MeetingSheetView.androidInitialBodyRevealDelayNanoseconds, 0)
        XCTAssertTrue(MeetingSheetRevealPolicy.shouldRevealImmediately(
            after: MeetingSheetView.androidInitialBodyRevealDelayNanoseconds
        ))
        XCTAssertFalse(MeetingSheetRevealPolicy.shouldHideBodyBeforeReveal(
            after: MeetingSheetView.androidInitialBodyRevealDelayNanoseconds
        ))
        XCTAssertEqual(MeetingSheetView.androidNavigationBodyRevealDelayNanoseconds, 0)
        XCTAssertTrue(MeetingSheetRevealPolicy.shouldRevealImmediately(
            after: MeetingSheetView.androidNavigationBodyRevealDelayNanoseconds
        ))
        XCTAssertFalse(MeetingSheetRevealPolicy.shouldHideBodyBeforeReveal(
            after: MeetingSheetView.androidNavigationBodyRevealDelayNanoseconds
        ))
        XCTAssertTrue(MeetingSheetRevealPolicy.shouldHideBodyBeforeReveal(after: 1))
        XCTAssertTrue(MeetingSheetRevealPolicy.shouldApply(generation: 4, currentGeneration: 4))
        XCTAssertFalse(MeetingSheetRevealPolicy.shouldApply(generation: 4, currentGeneration: 5))
    }

    func testSettingsDraftSyncPolicyPreservesActiveWebinarDraftEdits() throws {
        XCTAssertFalse(SettingsDraftSyncPolicy.shouldSyncWebinarCapacityDraft(
            page: SettingsSheetPage.webinarCapacity,
            hasLocalEdits: true
        ))
        XCTAssertTrue(SettingsDraftSyncPolicy.shouldSyncWebinarCapacityDraft(
            page: SettingsSheetPage.webinarCapacity,
            hasLocalEdits: false
        ))
        XCTAssertTrue(SettingsDraftSyncPolicy.shouldSyncWebinarCapacityDraft(
            page: SettingsSheetPage.webinarLink,
            hasLocalEdits: true
        ))

        XCTAssertFalse(SettingsDraftSyncPolicy.shouldSyncWebinarLinkDraft(
            page: SettingsSheetPage.webinarLink,
            hasLocalEdits: true
        ))
        XCTAssertTrue(SettingsDraftSyncPolicy.shouldSyncWebinarLinkDraft(
            page: SettingsSheetPage.webinarLink,
            hasLocalEdits: false
        ))
        XCTAssertTrue(SettingsDraftSyncPolicy.shouldSyncWebinarLinkDraft(
            page: SettingsSheetPage.webinarCapacity,
            hasLocalEdits: true
        ))
    }

    func testSettingsRefreshPolicyOnlyRefreshesAdminConfigPages() throws {
        XCTAssertTrue(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.overview, isAdmin: true))
        XCTAssertTrue(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.roomAccess, isAdmin: true))
        XCTAssertTrue(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.webinarLink, isAdmin: true))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.overview, isAdmin: false))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.profile, isAdmin: true))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.audioVideo, isAdmin: true))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.microphone, isAdmin: true))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.camera, isAdmin: true))
        XCTAssertFalse(SettingsRefreshPolicy.shouldRefreshAdminConfig(page: SettingsSheetPage.speaker, isAdmin: true))
    }

    func testSettingsRefreshPolicyTargetsOnlyVisibleConfigFamily() throws {
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.overview,
                isAdmin: true,
                isWebinarEnabled: true
            ),
            [SettingsConfigRefreshTarget.meeting, SettingsConfigRefreshTarget.webinar]
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.overview,
                isAdmin: true,
                isWebinarEnabled: false
            ),
            [SettingsConfigRefreshTarget.meeting]
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.roomCommunication,
                isAdmin: true,
                isWebinarEnabled: false
            ),
            [SettingsConfigRefreshTarget.meeting]
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.webinarCapacity,
                isAdmin: true,
                isWebinarEnabled: false
            ),
            [SettingsConfigRefreshTarget.webinar]
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.audioVideo,
                isAdmin: true,
                isWebinarEnabled: true
            ),
            []
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.refreshTargets(
                page: SettingsSheetPage.overview,
                isAdmin: false,
                isWebinarEnabled: true
            ),
            []
        )
    }

    func testSettingsRefreshPolicyDoesNotScheduleWhenSheetBodyIsNotReady() throws {
        XCTAssertEqual(
            SettingsRefreshPolicy.scheduledRefreshTargets(
                page: SettingsSheetPage.overview,
                isAdmin: true,
                bodyReady: false,
                isWebinarEnabled: true
            ),
            []
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.scheduledRefreshTargets(
                page: SettingsSheetPage.webinarLink,
                isAdmin: false,
                bodyReady: true,
                isWebinarEnabled: true
            ),
            []
        )
        XCTAssertEqual(
            SettingsRefreshPolicy.scheduledRefreshTargets(
                page: SettingsSheetPage.roomAccess,
                isAdmin: true,
                bodyReady: true,
                isWebinarEnabled: false
            ),
            [SettingsConfigRefreshTarget.meeting]
        )
    }

    func testSharedBrowserURLDraftSyncPolicyPreservesActiveEdits() throws {
        XCTAssertEqual(
            SharedBrowserURLDraftSyncPolicy.nextInput(
                currentInput: "https://typed.example",
                browserURL: "https://remote.example",
                isBrowserActive: true,
                hasLocalEdits: true
            ),
            "https://typed.example"
        )

        XCTAssertEqual(
            SharedBrowserURLDraftSyncPolicy.nextInput(
                currentInput: "",
                browserURL: "https://remote.example",
                isBrowserActive: true,
                hasLocalEdits: false
            ),
            "https://remote.example"
        )

        XCTAssertEqual(
            SharedBrowserURLDraftSyncPolicy.nextInput(
                currentInput: "https://typed.example",
                browserURL: nil,
                isBrowserActive: false,
                hasLocalEdits: true
            ),
            "https://typed.example"
        )

        XCTAssertEqual(
            SharedBrowserURLDraftSyncPolicy.nextInput(
                currentInput: "https://stale.example",
                browserURL: nil,
                isBrowserActive: false,
                hasLocalEdits: false
            ),
            ""
        )
    }

    func testPipVideoRefreshPolicyRecoversWhenTrackTokenDisappearsInPip() throws {
        XCTAssertTrue(PipVideoRefreshPolicy.shouldRequestDecoderRefresh(
            requestKeyFrame: false,
            targetChanged: false,
            previousTrackToken: "remote:track-a",
            currentTrackToken: nil,
            isInPictureInPicture: true
        ))
    }

    func testPipVideoRefreshPolicyDoesNotRefreshOutsidePip() throws {
        XCTAssertFalse(PipVideoRefreshPolicy.shouldRequestDecoderRefresh(
            requestKeyFrame: true,
            targetChanged: true,
            previousTrackToken: "remote:track-a",
            currentTrackToken: nil,
            isInPictureInPicture: false
        ))
    }

    func testPipModeObservationReappliesConsumerPolicyOnlyOnTransitions() throws {
        XCTAssertTrue(PipModeObservationPolicy.shouldReapplyRemoteConsumerPolicy(
            wasInPictureInPicture: false,
            isInPictureInPicture: true
        ))
        XCTAssertTrue(PipModeObservationPolicy.shouldReapplyRemoteConsumerPolicy(
            wasInPictureInPicture: true,
            isInPictureInPicture: false
        ))
        XCTAssertFalse(PipModeObservationPolicy.shouldReapplyRemoteConsumerPolicy(
            wasInPictureInPicture: true,
            isInPictureInPicture: true
        ))
        XCTAssertFalse(PipModeObservationPolicy.shouldReapplyRemoteConsumerPolicy(
            wasInPictureInPicture: false,
            isInPictureInPicture: false
        ))
    }

    func testAndroidPipExitNotifiesMeetingViewModelForPolicyRefresh() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/PipManager.kt")

        XCTAssertTrue(source.contains("val wasInPip = PipController.inPipMode"))
        XCTAssertTrue(source.contains("if (wasInPip) {\n            CallActionDispatcher.pictureInPictureContentRefresh()\n        }"))
        XCTAssertTrue(source.contains("if (!inPip) {\n            cancelPendingEnterPip()\n            CallActionDispatcher.pictureInPictureContentRefresh()\n            return\n        }"))
    }

    func testAndroidPipRendererKeyTracksTargetAndTrackIdentity() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/PipContent.kt")

        XCTAssertTrue(source.contains("val trackKey = videoState.track.id()"))
        XCTAssertTrue(source.contains("rendererKey = \"pip:${videoState.surfaceVersion}:${videoState.targetId}:$trackKey\""))
        XCTAssertTrue(source.contains("clearBeforeAttach = false"))
    }

    func testAndroidMeetingVideoRendererDoesNotClearStableTrackReattachments() throws {
        let source = try sourceFileContents("Sources/Conclave/Core/WebRTC/VideoView+Skip.swift")

        XCTAssertTrue(source.contains("var clearBeforeAttach = false"))
        XCTAssertTrue(source.contains("rendererKey: stableRendererKey,\n                clearBeforeAttach: clearBeforeAttach"))
    }

    func testPipTargetSelectionPrefersPresentCandidateWithoutWaitingForVideoTrack() throws {
        XCTAssertEqual(
            PipTargetSelectionPolicy.targetId(
                candidateId: "active-speaker",
                isCandidatePresent: true,
                previousTargetId: "previous-speaker",
                isPreviousTargetPresent: true
            ),
            "active-speaker"
        )
    }

    func testPipTargetSelectionWaitsForVideoTrackUnlessCameraIsOff() throws {
        XCTAssertFalse(PipTargetSelectionPolicy.shouldSelectParticipant(isCameraOff: false, hasVideoTrack: false))
        XCTAssertTrue(PipTargetSelectionPolicy.shouldSelectParticipant(isCameraOff: false, hasVideoTrack: true))
        XCTAssertTrue(PipTargetSelectionPolicy.shouldSelectParticipant(isCameraOff: true, hasVideoTrack: false))
    }

    func testPipTargetSelectionFallsBackOnlyWhenCandidateIsAbsent() throws {
        XCTAssertEqual(
            PipTargetSelectionPolicy.targetId(
                candidateId: "departed-speaker",
                isCandidatePresent: false,
                previousTargetId: "previous-speaker",
                isPreviousTargetPresent: true
            ),
            "previous-speaker"
        )

        XCTAssertEqual(
            PipTargetSelectionPolicy.targetId(
                candidateId: "departed-speaker",
                isCandidatePresent: false,
                previousTargetId: "previous-speaker",
                isPreviousTargetPresent: false
            ),
            "departed-speaker"
        )
    }

    func testMeetingMediaErrorPresentationMatchesWebMeetErrors() throws {
        XCTAssertEqual(
            MeetingMediaErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Camera permission not granted"]
            )),
            "Camera/microphone permission denied"
        )
        XCTAssertEqual(
            MeetingMediaErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "DevicesNotFoundError"]
            )),
            "Camera or microphone not found"
        )
        XCTAssertEqual(
            MeetingMediaErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Send transport not ready"]
            )),
            "Failed to connect to server"
        )
        XCTAssertEqual(
            MeetingMediaErrorPresentation.message(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "No rear camera available"]
            )),
            "No rear camera available"
        )
        XCTAssertEqual(
            MeetingMediaErrorPresentation.screenShareMessage(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "No screen capture permission"]
            )),
            "Failed to toggle screen sharing: Screen sharing permission denied"
        )
        XCTAssertEqual(
            MeetingMediaErrorPresentation.screenShareMessage(for: NSError(
                domain: "test",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Send transport not ready"]
            )),
            "Failed to toggle screen sharing: Failed to connect to server"
        )
    }

    func testDisplayNameSnapshotProducerSyncPolicyOnlySyncsJoinedClearedDepartures() throws {
        XCTAssertTrue(DisplayNameSnapshotProducerSyncPolicy.shouldSyncAfterPresenceSnapshot(
            clearedDepartedParticipant: true,
            connectionState: ConnectionState.joined
        ))
        XCTAssertFalse(DisplayNameSnapshotProducerSyncPolicy.shouldSyncAfterPresenceSnapshot(
            clearedDepartedParticipant: false,
            connectionState: ConnectionState.joined
        ))
        XCTAssertFalse(DisplayNameSnapshotProducerSyncPolicy.shouldSyncAfterPresenceSnapshot(
            clearedDepartedParticipant: true,
            connectionState: ConnectionState.joining
        ))
        XCTAssertFalse(DisplayNameSnapshotProducerSyncPolicy.shouldSyncAfterPresenceSnapshot(
            clearedDepartedParticipant: true,
            connectionState: ConnectionState.reconnecting
        ))
    }

    func testReplacementProducerCleanupOnlyTargetsUncommittedProducer() throws {
        XCTAssertTrue(ReplacementProducerCleanupPolicy.shouldCloseUncommittedReplacement(
            replacementProducerId: " producer-new ",
            currentProducerId: "producer-old"
        ))
        XCTAssertFalse(ReplacementProducerCleanupPolicy.shouldCloseUncommittedReplacement(
            replacementProducerId: "producer-new",
            currentProducerId: " producer-new "
        ))
        XCTAssertFalse(ReplacementProducerCleanupPolicy.shouldCloseUncommittedReplacement(
            replacementProducerId: "   ",
            currentProducerId: "producer-old"
        ))
        XCTAssertFalse(ReplacementProducerCleanupPolicy.shouldCloseUncommittedReplacement(
            replacementProducerId: nil,
            currentProducerId: "producer-old"
        ))
    }

    func testCompactDetachedSelfViewLeavesRoomAboveControls() throws {
        let compactInsets = MeetingDetachedSelfLayout.edgeInsets(isCompact: true)
        let regularInsets = MeetingDetachedSelfLayout.edgeInsets(isCompact: false)
        let compactSpotlightInsets = MeetingDetachedSelfLayout.spotlightEdgeInsets(isCompact: true)
        let compactSize = MeetingDetachedSelfLayout.floatingSize(isCompact: true)
        let regularSize = MeetingDetachedSelfLayout.floatingSize(isCompact: false)

        XCTAssertGreaterThanOrEqual(compactInsets.bottom, 120)
        XCTAssertGreaterThanOrEqual(compactSpotlightInsets.bottom, 120)
        XCTAssertEqual(regularInsets.bottom, 16)
        XCTAssertLessThan(compactSize.width, regularSize.width)
        XCTAssertLessThan(compactSize.height, regularSize.height)
        XCTAssertLessThan(
            MeetingDetachedSelfLayout.floatingAvatarSize(isCompact: true),
            MeetingDetachedSelfLayout.floatingAvatarSize(isCompact: false)
        )
    }

    func testNativeJoinLinkParserParsesMeetingWebURL() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/asuna-pansy-soma",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
        XCTAssertTrue(target.allowRoomCreation)
        XCTAssertNil(target.meetingInviteCode)
        XCTAssertNil(target.webinarInviteCode)
    }

    func testNativeJoinLinkParserParsesWebinarPathAsAttendee() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/w/yuki-haz?joinMode=meeting&inviteCode=secret",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "yuki-haz")
        XCTAssertEqual(target.joinMode, .webinarAttendee)
        XCTAssertFalse(target.allowRoomCreation)
        XCTAssertNil(target.meetingInviteCode)
        XCTAssertEqual(target.webinarInviteCode, "secret")
    }

    func testNativeJoinLinkParserDecodesPercentEncodedMeetingPathLikeWeb() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/asuna%20pansy%20soma?invite=meet-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
        XCTAssertTrue(target.allowRoomCreation)
        XCTAssertEqual(target.meetingInviteCode, "meet-code")
    }

    func testNativeJoinLinkParserDecodesPercentEncodedWebinarSlugLikeWeb() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/w/yuki%2Dhaz?invite=web-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "yuki-haz")
        XCTAssertEqual(target.joinMode, .webinarAttendee)
        XCTAssertFalse(target.allowRoomCreation)
        XCTAssertEqual(target.webinarInviteCode, "web-code")
    }

    func testNativeJoinLinkParserDecodesBarePercentEncodedCodesLikeWeb() throws {
        let meeting = NativeJoinLinkParser.parse("asuna%20pansy%20soma?invite=meet-code")
        let webinar = NativeJoinLinkParser.parse("yuki%2Dhaz?mode=webinar_attendee&invite=web-code")

        XCTAssertEqual(meeting.roomId, "asuna-pansy-soma")
        XCTAssertEqual(meeting.joinMode, .meeting)
        XCTAssertEqual(meeting.meetingInviteCode, "meet-code")
        XCTAssertEqual(webinar.roomId, "yuki-haz")
        XCTAssertEqual(webinar.joinMode, .webinarAttendee)
        XCTAssertEqual(webinar.webinarInviteCode, "web-code")
    }

    func testNativeJoinLinkParserParsesCustomSchemeWebinarLink() throws {
        let target = NativeJoinLinkParser.parse("conclave://w/Tanji-Riku-Lotus")

        XCTAssertEqual(target.roomId, "tanji-riku-lotus")
        XCTAssertEqual(target.joinMode, .webinarAttendee)
    }

    func testNativeJoinLinkParserRejectsBareWebinarPrefixURLs() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/w").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/w/").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("conclave://w").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("conclave://w/").roomId, "")
    }

    func testNativeJoinLinkParserKeepsPlainBareWAsMeetingCode() throws {
        let target = NativeJoinLinkParser.parse("w")

        XCTAssertEqual(target.roomId, "w")
        XCTAssertEqual(target.joinMode, .meeting)
    }

    func testNativeJoinLinkParserRejectsPlaceholderRouteCodesLikeWeb() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/undefined").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/null").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/%75ndefined").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/w/undefined").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/w/null").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("undefined?invite=meet-code").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("null?mode=webinar_attendee").roomId, "")
    }

    func testNativeJoinLinkParserRejectsPlaceholderSignInNextTargetsLikeWeb() throws {
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2Fundefined%3Finvite%3Dmeet-code").roomId,
            ""
        )
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2Fw%2Fnull%3Finvite%3Dweb-code").roomId,
            ""
        )
    }

    func testNativeJoinLinkParserRoutesInviteCodeByExplicitMode() throws {
        let meeting = NativeJoinLinkParser.parse("tanji-riku-lotus?mode=meeting&invite=meet-code")
        let webinar = NativeJoinLinkParser.parse("tanji-riku-lotus?mode=webinar_attendee&invite=web-code")

        XCTAssertEqual(meeting.joinMode, .meeting)
        XCTAssertEqual(meeting.meetingInviteCode, "meet-code")
        XCTAssertNil(meeting.webinarInviteCode)
        XCTAssertEqual(webinar.joinMode, .webinarAttendee)
        XCTAssertNil(webinar.meetingInviteCode)
        XCTAssertEqual(webinar.webinarInviteCode, "web-code")
    }

    func testNativeJoinLinkParserCarriesValidClientIdLikeWeb() throws {
        let meeting = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/tanji-riku-lotus?clientId=acm.dev-1",
            allowRoomCreationForURLs: true
        )
        let webinar = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/w/yuki-haz?clientId=acm:events_2026",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(meeting.clientId, "acm.dev-1")
        XCTAssertEqual(webinar.clientId, "acm:events_2026")
        XCTAssertTrue(meeting.preservesRetryContext)
        XCTAssertTrue(webinar.preservesRetryContext)
    }

    func testNativeJoinLinkParserCarriesClientIdFromSafeSignInNextTarget() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/sign-in?next=%2Ftanji-riku-lotus%3FclientId%3Dacm.dev-1",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "tanji-riku-lotus")
        XCTAssertEqual(target.clientId, "acm.dev-1")
    }

    func testNativeJoinLinkParserIgnoresInvalidClientIdsLikeWeb() throws {
        let invalidCharacter = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/tanji-riku-lotus?clientId=bad/client",
            allowRoomCreationForURLs: true
        )
        let overlong = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/tanji-riku-lotus?clientId=\(String(repeating: "a", count: 65))",
            allowRoomCreationForURLs: true
        )

        XCTAssertNil(invalidCharacter.clientId)
        XCTAssertNil(overlong.clientId)
    }

    func testNativeJoinLinkParserRejectsWebOnlyConclavePaths() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/api/sfu/join").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/api%2Fsfu%2Fjoin").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/chat-qa").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/privacy").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/favicon.ico").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("conclave://api/sfu/join").roomId, "")
    }

    func testNativeJoinLinkParserRejectsRawWebOnlyConclavePaths() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("api/sfu/join").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("api%2Fsfu%2Fjoin").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("_next/static/app.js").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("favicon.ico").roomId, "")
    }

    func testNativeJoinLinkParserRejectsMultiSegmentRoutesThatWebWouldNotJoin() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/asuna/pansy").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://conclave.acmvit.in/w/yuki-haz/extra").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("conclave://asuna/pansy").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("asuna/pansy").roomId, "")
    }

    func testNativeJoinLinkParserFollowsSafeSignInNextTarget() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/sign-in?next=%2Fasuna-pansy-soma%3FinviteCode%3Dmeet-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
        XCTAssertTrue(target.allowRoomCreation)
        XCTAssertEqual(target.meetingInviteCode, "meet-code")
        XCTAssertNil(target.webinarInviteCode)
    }

    func testNativeJoinLinkParserDecodesSafeSignInNextTargetPathLikeWeb() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/sign-in?next=%2Fasuna%2520pansy%2520soma%3Finvite%3Dmeet-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
        XCTAssertTrue(target.allowRoomCreation)
        XCTAssertEqual(target.meetingInviteCode, "meet-code")
    }

    func testNativeJoinLinkParserFollowsSafeCustomSchemeSignInNextTarget() throws {
        let target = NativeJoinLinkParser.parse(
            "conclave://sign-in?next=%2Fasuna-pansy-soma%3FinviteCode%3Dmeet-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
        XCTAssertTrue(target.allowRoomCreation)
        XCTAssertEqual(target.meetingInviteCode, "meet-code")
        XCTAssertNil(target.webinarInviteCode)
    }

    func testNativeJoinLinkParserFollowsSafeWebinarNextTarget() throws {
        let target = NativeJoinLinkParser.parse(
            "https://conclave.acmvit.in/sign-in?next=%2Fw%2Fyuki-haz%3Finvite%3Dweb-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(target.roomId, "yuki-haz")
        XCTAssertEqual(target.joinMode, .webinarAttendee)
        XCTAssertFalse(target.allowRoomCreation)
        XCTAssertNil(target.meetingInviteCode)
        XCTAssertEqual(target.webinarInviteCode, "web-code")
    }

    func testNativeJoinLinkParserRejectsExternalNextTarget() throws {
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2F%2Fevil.example%2Froom").roomId,
            ""
        )
    }

    func testNativeJoinLinkParserRejectsUnsafeNextPathSegments() throws {
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2F..%2Fasuna-pansy-soma").roomId,
            ""
        )
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2Fw%2F%252E%252E%2Fyuki-haz").roomId,
            ""
        )
        XCTAssertEqual(
            NativeJoinLinkParser.parse("conclave://sign-in?next=%2F.%2Fasuna-pansy-soma").roomId,
            ""
        )
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/%252E%252E/asuna-pansy-soma").roomId,
            ""
        )
    }

    func testNativeJoinLinkParserRejectsMultiSegmentNextTargets() throws {
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2Fasuna%2Fpansy").roomId,
            ""
        )
        XCTAssertEqual(
            NativeJoinLinkParser.parse("https://conclave.acmvit.in/sign-in?next=%2Fw%2Fyuki-haz%2Fextra").roomId,
            ""
        )
    }

    func testNativeJoinLinkParserRejectsUnsafeBareEncodedPathSegments() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("..%2Fasuna-pansy-soma").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("w%2F..%2Fyuki-haz?mode=webinar_attendee").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse(".%2Fasuna-pansy-soma?invite=meet-code").roomId, "")
    }

    func testNativeJoinLinkParserRejectsExternalWebURLs() throws {
        XCTAssertEqual(NativeJoinLinkParser.parse("https://example.com/asuna-pansy-soma").roomId, "")
        XCTAssertEqual(NativeJoinLinkParser.parse("https://meet.google.com/abc-defg-hij").roomId, "")
    }

    func testNativeJoinLinkParserNormalizesBareConclaveHostURL() throws {
        let target = NativeJoinLinkParser.parse("conclave.acmvit.in/asuna-pansy-soma")

        XCTAssertEqual(target.roomId, "asuna-pansy-soma")
        XCTAssertEqual(target.joinMode, .meeting)
    }

    func testNativeJoinLinkParserAcceptsWwwProductionHost() throws {
        let meeting = NativeJoinLinkParser.parse(
            "https://www.conclave.acmvit.in/asuna-pansy-soma",
            allowRoomCreationForURLs: true
        )
        let webinar = NativeJoinLinkParser.parse(
            "https://www.conclave.acmvit.in/w/yuki-haz?invite=web-code",
            allowRoomCreationForURLs: true
        )

        XCTAssertEqual(meeting.roomId, "asuna-pansy-soma")
        XCTAssertEqual(meeting.joinMode, .meeting)
        XCTAssertTrue(meeting.allowRoomCreation)
        XCTAssertEqual(webinar.roomId, "yuki-haz")
        XCTAssertEqual(webinar.joinMode, .webinarAttendee)
        XCTAssertEqual(webinar.webinarInviteCode, "web-code")
        XCTAssertFalse(webinar.allowRoomCreation)
    }

    @MainActor
    func testConclaveAppDelegateOnlyQueuesSupportedJoinLinks() throws {
        let state = AppState.shared
        let previousPendingJoinURLString = state.pendingJoinURLString
        let previousPendingJoinRequestID = state.pendingJoinRequestID
        defer {
            state.pendingJoinURLString = previousPendingJoinURLString
            state.pendingJoinRequestID = previousPendingJoinRequestID
        }

        state.pendingJoinURLString = nil
        state.pendingJoinRequestID = previousPendingJoinRequestID
        let openURL: (URL) -> Bool = ConclaveAppDelegate.shared.onOpenURL

        let ignoredURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in/privacy?case=\(UUID().uuidString)"))
        XCTAssertFalse(openURL(ignoredURL))
        XCTAssertNil(state.pendingJoinURLString)
        XCTAssertEqual(state.pendingJoinRequestID, previousPendingJoinRequestID)

        let joinURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in/native-regression-room?case=\(UUID().uuidString)"))
        XCTAssertTrue(openURL(joinURL))
        XCTAssertEqual(state.pendingJoinURLString, joinURL.absoluteString)
        XCTAssertEqual(state.pendingJoinRequestID, previousPendingJoinRequestID + 1)
    }

    func testNativeScheduledWebinarURLPercentEncodesSlugPathSegment() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in"))
        let url = try XCTUnwrap(NativeWebinarLookupService.scheduledWebinarURL(
            slug: "webinar/slug?x=1",
            baseURL: baseURL
        ))

        XCTAssertEqual(url.absoluteString, "https://conclave.acmvit.in/api/webinars/by-slug/webinar%2Fslug%3Fx=1")
    }

    func testNativeScheduledWebinarURLRejectsEmptySlug() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://conclave.acmvit.in"))

        XCTAssertNil(NativeWebinarLookupService.scheduledWebinarURL(slug: "   ", baseURL: baseURL))
    }

    func testNativeScheduledWebinarLookupUsesLinkScopedClientIdWhenPresent() throws {
        XCTAssertEqual(
            NativeWebinarLookupService.resolvedClientId(override: " acm.dev-1 "),
            "acm.dev-1"
        )
        XCTAssertEqual(
            NativeWebinarLookupService.resolvedClientId(override: nil),
            SfuJoinService.resolveClientId()
        )
    }

    func testNativeAuthBaseURLResolverNormalizesConfiguredBase() throws {
        let url = try XCTUnwrap(NativeAuthService.configuredAppBaseURL(
            from: "https://conclave.acmvit.in/sign-in?next=%2Froom"
        ))

        XCTAssertEqual(url.absoluteString, "https://conclave.acmvit.in")
    }

    func testNativeAuthProductionBaseURLResolverAcceptsConclaveHostOnly() throws {
        let production = try XCTUnwrap(NativeAuthService.configuredProductionAppBaseURL(
            from: "https://conclave.acmvit.in/sign-in"
        ))
        let wwwProduction = try XCTUnwrap(NativeAuthService.configuredProductionAppBaseURL(
            from: "https://www.conclave.acmvit.in"
        ))

        XCTAssertEqual(production.absoluteString, "https://conclave.acmvit.in")
        XCTAssertEqual(wwwProduction.absoluteString, "https://www.conclave.acmvit.in")
    }

    func testNativeAuthProductionBaseURLResolverRejectsLocalURLs() throws {
        XCTAssertNil(NativeAuthService.configuredProductionAppBaseURL(from: "http://127.0.0.1:3000"))
        XCTAssertNil(NativeAuthService.configuredProductionAppBaseURL(from: "http://10.0.2.2:3000"))
        XCTAssertNil(NativeAuthService.configuredProductionAppBaseURL(from: "https://staging.example.com"))
        XCTAssertNil(NativeAuthService.configuredProductionAppBaseURL(from: "$(CONCLAVE_AUTH_BASE_URL)"))
    }

    func testNativeAuthProductionBaseURLResolverRequiresHttps() throws {
        XCTAssertNil(NativeAuthService.configuredProductionAppBaseURL(from: "http://conclave.acmvit.in"))
    }

    func testSfuJoinURLResolverRejectsUnresolvedBuildSettings() throws {
        XCTAssertNil(SfuJoinService.configuredJoinURL(from: "$(SFU_JOIN_URL)", allowProductionHost: true))
        XCTAssertNil(SfuJoinService.configuredJoinURL(from: "${SFU_JOIN_URL}", allowProductionHost: true))
    }

    func testSfuJoinURLResolverKeepsProductionURLForReleaseTargets() throws {
        let production = try XCTUnwrap(SfuJoinService.configuredJoinURL(
            from: "https://conclave.acmvit.in/api/sfu/join",
            allowProductionHost: true
        ))

        XCTAssertEqual(production.scheme, "https")
        XCTAssertEqual(production.host, "conclave.acmvit.in")
        XCTAssertEqual(production.path, "/api/sfu/join")
    }

    func testSfuJoinURLResolverRejectsNonCanonicalProductionURLs() throws {
        XCTAssertNil(SfuJoinService.configuredJoinURL(
            from: "http://conclave.acmvit.in/api/sfu/join",
            allowProductionHost: true
        ))
        XCTAssertNil(SfuJoinService.configuredJoinURL(
            from: "https://conclave.acmvit.in/api/sfu/join?debug=true",
            allowProductionHost: true
        ))
        XCTAssertNil(SfuJoinService.configuredJoinURL(
            from: "https://conclave.acmvit.in/api/sfu/join#native",
            allowProductionHost: true
        ))
    }

    func testSfuProductionJoinURLResolverRejectsLocalURLs() throws {
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "http://127.0.0.1:3000/api/sfu/join"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "http://10.0.2.2:3000/api/sfu/join"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "https://staging.example.com/api/sfu/join"))
    }

    func testSfuProductionJoinURLResolverRequiresHttpsJoinEndpoint() throws {
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "http://conclave.acmvit.in/api/sfu/join"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "https://conclave.acmvit.in/privacy"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "https://conclave.acmvit.in"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "https://conclave.acmvit.in/api/sfu/join?debug=true"))
        XCTAssertNil(SfuJoinService.configuredProductionJoinURL(from: "https://conclave.acmvit.in/api/sfu/join#native"))
    }

    func testSfuProductionJoinURLResolverAcceptsConclaveHostOnly() throws {
        let production = try XCTUnwrap(SfuJoinService.configuredProductionJoinURL(
            from: "https://conclave.acmvit.in/api/sfu/join"
        ))

        XCTAssertEqual(production.scheme, "https")
        XCTAssertEqual(production.host, "conclave.acmvit.in")
        XCTAssertEqual(production.path, "/api/sfu/join")
    }

    func testSfuJoinURLResolverCanRejectProductionURLForSimulatorDebugOverride() throws {
        XCTAssertNil(SfuJoinService.configuredJoinURL(
            from: "https://conclave.acmvit.in/api/sfu/join",
            allowProductionHost: false
        ))
    }

    func testRoomPolicyMutationResponseDecodesObjectShapedChangedAck() throws {
        let data = Data("""
        {
          "success": true,
          "changed": {
            "locked": true
          },
          "locked": true
        }
        """.utf8)

        let response = try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.changed, true)
        XCTAssertEqual(response.locked, true)
    }

    func testRoomPolicyMutationResponseKeepsBooleanChangedAckSupport() throws {
        let data = Data("""
        {
          "success": true,
          "changed": false,
          "enabled": false
        }
        """.utf8)

        let response = try JSONDecoder().decode(RoomPolicyMutationResponse.self, from: data)

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.changed, false)
        XCTAssertEqual(response.enabled, false)
    }

    func testAdminRoomPoliciesUpdateRequestOmitsNilPolicyFields() throws {
        let request = AdminRoomPoliciesUpdateRequest(
            locked: true,
            noGuests: nil,
            chatLocked: false,
            ttsDisabled: nil,
            dmEnabled: true,
            reactionsDisabled: nil
        )
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertEqual(object["locked"] as? Bool, true)
        XCTAssertEqual(object["chatLocked"] as? Bool, false)
        XCTAssertEqual(object["dmEnabled"] as? Bool, true)
        XCTAssertNil(object["noGuests"])
        XCTAssertNil(object["ttsDisabled"])
        XCTAssertNil(object["reactionsDisabled"])
    }

    func testRoomListResponseDecodesWebRoomShape() throws {
        let data = Data("""
        {
          "rooms": [
            { "id": "alpha-room", "userCount": 2 },
            { "id": "beta-room", "userCount": 0 }
          ]
        }
        """.utf8)

        let response = try JSONDecoder().decode(RoomListResponse.self, from: data)

        XCTAssertEqual(response.rooms, [
            RoomInfo(id: "alpha-room", userCount: 2),
            RoomInfo(id: "beta-room", userCount: 0),
        ])
    }

    func testAdminRoomsDetailedResponseDecodesRoomSnapshots() throws {
        let data = Data("""
        {
          "rooms": [
            {
              "id": "alpha-room",
              "hostUserId": "host-1",
              "adminUserIds": ["host-1"],
              "participants": [
                { "userId": "user-1", "displayName": "Alex", "muted": false }
              ],
              "pendingUsers": [
                { "userId": "pending-1", "displayName": "Taylor" }
              ]
            }
          ]
        }
        """.utf8)

        let response = try JSONDecoder().decode(AdminRoomsDetailedResponse.self, from: data)

        XCTAssertEqual(response.rooms.first?.id, "alpha-room")
        XCTAssertEqual(response.rooms.first?.hostUserId, "host-1")
        XCTAssertEqual(response.rooms.first?.participants?.first?.displayName, "Alex")
        XCTAssertEqual(response.rooms.first?.pendingUsers?.first?.displayName, "Taylor")
    }

    func testAdminParticipantAndPendingUserResponsesDecodeSnapshots() throws {
        let participantsData = Data("""
        {
          "roomId": "alpha-room",
          "participants": [
            { "userId": "user-1", "displayName": "Alex", "cameraOff": true }
          ]
        }
        """.utf8)
        let pendingData = Data("""
        {
          "roomId": "alpha-room",
          "users": [
            { "userId": "pending-1", "displayName": "Taylor" }
          ]
        }
        """.utf8)

        let participants = try JSONDecoder().decode(AdminParticipantsResponse.self, from: participantsData)
        let pending = try JSONDecoder().decode(AdminPendingUsersResponse.self, from: pendingData)

        XCTAssertEqual(participants.roomId, "alpha-room")
        XCTAssertEqual(participants.participants.first?.displayName, "Alex")
        XCTAssertEqual(participants.participants.first?.cameraOff, true)
        XCTAssertEqual(pending.roomId, "alpha-room")
        XCTAssertEqual(pending.users.first?.displayName, "Taylor")
    }

    func testTransferHostResponseDecodesSfuAckShape() throws {
        let data = Data("""
        {
          "success": true,
          "hostUserId": "user-1",
          "hostUserIds": ["user-1", "user-2"],
          "transferredTo": "user-1"
        }
        """.utf8)

        let response = try JSONDecoder().decode(TransferHostResponse.self, from: data)

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.hostUserId, "user-1")
        XCTAssertEqual(response.hostUserIds, ["user-1", "user-2"])
        XCTAssertEqual(response.transferredTo, "user-1")
    }

    func testRedirectUserRequestEncodesWebPayloadShape() throws {
        let data = try JSONEncoder().encode(RedirectUserRequest(userId: "user-1", newRoomId: "beta-room"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertEqual(object["userId"] as? String, "user-1")
        XCTAssertEqual(object["newRoomId"] as? String, "beta-room")
    }

    func testMeetingConfigClearInviteCodeEncodesExplicitNull() throws {
        let data = try JSONEncoder().encode(MeetingConfigUpdateRequest(inviteCode: nil))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertNotNil(object["inviteCode"])
        XCTAssertTrue(object["inviteCode"] is NSNull)
    }

    func testMeetingConfigSetInviteCodeEncodesValue() throws {
        let data = try JSONEncoder().encode(MeetingConfigUpdateRequest(inviteCode: "native-code"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertEqual(object["inviteCode"] as? String, "native-code")
    }

    func testFireAndForgetSocketEmitsRequireJoinedRoomAndSocket() throws {
        XCTAssertTrue(SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: true,
            activeRoomId: " tanji-riku-lotus ",
            hasSocket: true
        ))
        XCTAssertFalse(SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: false,
            activeRoomId: "tanji-riku-lotus",
            hasSocket: true
        ))
        XCTAssertFalse(SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: true,
            activeRoomId: "   ",
            hasSocket: true
        ))
        XCTAssertFalse(SocketFireAndForgetEmitPolicy.shouldEmit(
            isConnected: true,
            activeRoomId: "tanji-riku-lotus",
            hasSocket: false
        ))
    }

    func testFireAndForgetSocketEmitsTrimAppIds() throws {
        XCTAssertEqual(
            SocketFireAndForgetEmitPolicy.normalizedAppId("  whiteboard  "),
            "whiteboard"
        )
        XCTAssertNil(SocketFireAndForgetEmitPolicy.normalizedAppId("   "))
    }

    func testConclaveAuthorizeRequestEncodesWebPayloadShape() throws {
        let data = try JSONEncoder().encode(ConclaveAuthorizeRequest(
            id: "answer-1",
            questionMessageId: "question-1"
        ))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertEqual(object["id"] as? String, "answer-1")
        XCTAssertEqual(object["questionMessageId"] as? String, "question-1")
    }

    func testConclaveAssistantRelayPacketEncodesSfuRelayShape() throws {
        let packet = ConclaveAssistantRelayPacket(
            id: "answer-1",
            roomId: "tanji-riku-lotus",
            channelId: "room:tanji-riku-lotus",
            requesterUserId: "user@example.com#session",
            questionMessageId: "question-1",
            content: "Here is the recap.",
            done: true,
            timestamp: 1_783_000_100_000,
            expiresAt: 1_783_000_160_000,
            signature: "signed-packet"
        )
        let data = try JSONEncoder().encode(packet)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)

        XCTAssertEqual(object["id"] as? String, "answer-1")
        XCTAssertEqual(object["roomId"] as? String, "tanji-riku-lotus")
        XCTAssertEqual(object["channelId"] as? String, "room:tanji-riku-lotus")
        XCTAssertEqual(object["requesterUserId"] as? String, "user@example.com#session")
        XCTAssertEqual(object["questionMessageId"] as? String, "question-1")
        XCTAssertEqual(object["content"] as? String, "Here is the recap.")
        XCTAssertEqual(object["done"] as? Bool, true)
        XCTAssertEqual(object["timestamp"] as? Double, 1_783_000_100_000)
        XCTAssertEqual(object["expiresAt"] as? Double, 1_783_000_160_000)
        XCTAssertEqual(object["signature"] as? String, "signed-packet")
    }

    func testNativeConclaveAssistantURLUsesWebEndpointPath() throws {
        let productionURL = try XCTUnwrap(NativeConclaveAssistantService.assistantURL(
            baseURL: URL(string: "https://conclave.acmvit.in")
        ))
        let nestedURL = try XCTUnwrap(NativeConclaveAssistantService.assistantURL(
            baseURL: URL(string: "https://conclave.acmvit.in/custom")
        ))

        XCTAssertEqual(productionURL.absoluteString, "https://conclave.acmvit.in/api/conclave/assistant")
        XCTAssertEqual(nestedURL.absoluteString, "https://conclave.acmvit.in/custom/api/conclave/assistant")
    }

    func testNativeConclaveAssistantStreamUsesFinalSignedRelay() throws {
        let packet = ConclaveAssistantRelayPacket(
            id: "answer-1",
            roomId: "room-a",
            channelId: "room:room-a",
            requesterUserId: "user@example.com#session",
            questionMessageId: "question-1",
            content: "Final native answer.",
            done: true,
            timestamp: 1_783_000_100_000,
            expiresAt: 1_783_000_160_000,
            signature: "signed-packet"
        )
        let relayObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(packet)) as? NSDictionary)
        let deltaData = try JSONSerialization.data(withJSONObject: [
            "type": "delta",
            "delta": "Draft "
        ])
        let doneData = try JSONSerialization.data(withJSONObject: [
            "type": "done",
            "relay": relayObject
        ])
        let body = [
            "data: \(String(data: deltaData, encoding: .utf8)!)",
            "",
            "data: \(String(data: doneData, encoding: .utf8)!)",
            ""
        ].joined(separator: "\n")

        let result = try NativeConclaveAssistantService.parseAssistantStream(body: body)

        XCTAssertEqual(result.content, "Final native answer.")
        XCTAssertEqual(result.relay?.id, "answer-1")
        XCTAssertEqual(result.relay?.signature, "signed-packet")
    }

    func testNativeConclaveAssistantStreamSurfacesServerError() throws {
        let errorData = try JSONSerialization.data(withJSONObject: [
            "type": "error",
            "error": "Enter an OpenAI API key to use Conclave AI."
        ])
        let body = "data: \(String(data: errorData, encoding: .utf8)!)\n\n"

        XCTAssertThrowsError(try NativeConclaveAssistantService.parseAssistantStream(body: body)) { error in
            XCTAssertEqual(error.localizedDescription, "Enter an OpenAI API key to use Conclave AI.")
        }
    }

    func testNativeConclaveAssistantAndroidBridgeUsesLongRunningRequestPath() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/AndroidNativeHttpClient.kt")

        XCTAssertTrue(source.contains("private val assistantClient = client.newBuilder()"))
        XCTAssertTrue(source.contains(".readTimeout(120, TimeUnit.SECONDS)"))
        XCTAssertTrue(source.contains(".callTimeout(150, TimeUnit.SECONDS)"))
        XCTAssertTrue(source.contains("fun requestAssistant("))
        XCTAssertTrue(source.contains("httpClient = assistantClient"))
    }

    func testTerminalRoomEventsAllowMissingRoomIdOnlyDuringKnownCall() throws {
        XCTAssertTrue(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 1,
            pendingRoomAliasCount: 0
        ))
        XCTAssertTrue(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 0,
            pendingRoomAliasCount: 1
        ))
        XCTAssertFalse(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 0,
            pendingRoomAliasCount: 0
        ))
        XCTAssertFalse(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 1,
            pendingRoomAliasCount: 1
        ))
    }

    func testIosGameVoteSocketEventFiltersDecodedVoteRoomIdLikeAndroid() throws {
        let iosSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let androidSource = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        XCTAssertTrue(iosSource.contains("let vote = data.first.flatMap { self.decode(GameVoteState.self, from: $0) }"))
        XCTAssertTrue(iosSource.contains("self.eventRoomIdMatchesActiveOrPending(vote?.roomId, allowMissingRoomId: true)"))
        XCTAssertFalse(iosSource.contains("self.eventRoomIdMatchesActiveOrPending(nil, allowMissingRoomId: true) else { return }\n            let vote"))
        XCTAssertTrue(androidSource.contains("val roomId = notification?.roomId"))
        XCTAssertTrue(androidSource.contains("eventRoomIdMatchesActiveOrPending(roomId, allowMissingRoomId = true)"))
    }

    func testConclaveMessageRoutesThroughNativeChatPipeline() throws {
        let iosSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let androidSource = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        let viewModelSource = try sourceFileContents("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")

        XCTAssertTrue(iosSource.contains("static let conclaveAuthorize = SfuClientEvent.conclaveAuthorize.rawValue"))
        XCTAssertTrue(iosSource.contains("static let conclaveMessage = SfuServerEvent.conclaveMessage.rawValue"))
        XCTAssertTrue(iosSource.contains("socket.on(SocketEvent.conclaveMessage)"))
        XCTAssertTrue(iosSource.contains("self.decode(ConclaveAssistantMessageNotification.self, from: first)"))
        XCTAssertTrue(iosSource.contains("self.onChatMessage?(notification.chatMessage(taggedRoomId: activeRoomId))"))

        XCTAssertTrue(androidSource.contains("val conclaveAuthorize = SfuClientEvent.conclaveAuthorize.rawValue"))
        XCTAssertTrue(androidSource.contains("val conclaveMessage = SfuServerEvent.conclaveMessage.rawValue"))
        XCTAssertTrue(androidSource.contains("socket.on(SocketEvent.conclaveMessage"))
        XCTAssertTrue(androidSource.contains("private fun decodeConclaveMessage(value: Any?): ChatMessageNotification?"))
        XCTAssertTrue(androidSource.contains("decodeChatMessage(value) ?: decodeConclaveAssistantMessage(value)"))
        XCTAssertTrue(androidSource.contains("onChatMessage?.invoke(notification.toChatMessage(roomId))"))

        XCTAssertTrue(viewModelSource.contains("guard normalized.userId == ConclaveAssistantChatIdentity.userId else"))
        XCTAssertTrue(viewModelSource.contains("private func mergedConclaveAssistantMessage(existing: ChatMessage, incoming: ChatMessage) -> ChatMessage"))
        XCTAssertTrue(viewModelSource.contains("incoming.content.isEmpty || incoming.content.count < existing.content.count"))
    }

    func testNativeConclaveAssistantSocketEmitParity() throws {
        let iosSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let androidSymbolSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager+Android.swift")
        let androidSource = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        XCTAssertTrue(iosSource.contains("func requestConclaveAuthorization(answerId: String, questionMessageId: String) async throws -> ConclaveAuthorizeResponse"))
        XCTAssertTrue(iosSource.contains("emit(event: SocketEvent.conclaveAuthorize"))
        XCTAssertTrue(iosSource.contains("func relayConclaveAnswer(_ packet: ConclaveAssistantRelayPacket)"))
        XCTAssertTrue(iosSource.contains("socket?.emit(SocketEvent.conclaveAnswer, payload)"))

        XCTAssertTrue(androidSymbolSource.contains("func requestConclaveAuthorization(answerId: String, questionMessageId: String) async throws -> ConclaveAuthorizeResponse"))
        XCTAssertTrue(androidSymbolSource.contains("func relayConclaveAnswer(_ packet: ConclaveAssistantRelayPacket)"))

        XCTAssertTrue(androidSource.contains("internal suspend fun requestConclaveAuthorization("))
        XCTAssertTrue(androidSource.contains("emit(SocketEvent.conclaveAuthorize, payload)"))
        XCTAssertTrue(androidSource.contains("internal fun relayConclaveAnswer(packet: ConclaveAssistantRelayPacket)"))
        XCTAssertTrue(androidSource.contains("socket?.emit(SocketEvent.conclaveAnswer, payload)"))
    }

    func testPayloadLessBrowserClosedCanClearOnlyKnownRoomState() throws {
        XCTAssertEqual(SfuServerEvent.browserClosed.rawValue, "browser:closed")
        XCTAssertTrue(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 1,
            pendingRoomAliasCount: 0
        ))
        XCTAssertFalse(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 0,
            pendingRoomAliasCount: 0
        ))
        XCTAssertFalse(SocketRoomEventPolicy.shouldAllowMissingTerminalRoomId(
            activeRoomAliasCount: 2,
            pendingRoomAliasCount: 1
        ))
    }

    func testAndroidLoopbackURLRewriteUsesReachableHost() throws {
        let rewritten = SfuJoinService.rewriteAndroidLoopbackURLString(
            "http://localhost:3000/api/sfu/join",
            fallbackHost: "10.0.2.2"
        )

        XCTAssertEqual(rewritten, "http://10.0.2.2:3000/api/sfu/join")
    }

    func testAndroidLocalDevelopmentHostClassificationCatchesEmulatorLoopback() throws {
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("localhost"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("127.0.0.1"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("10.0.2.2"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("10.0.3.2"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("10.1.2.3"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("172.20.1.10"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("192.168.1.20"))
        XCTAssertTrue(SfuJoinService.isAndroidLocalDevelopmentHost("169.254.10.20"))
        XCTAssertFalse(SfuJoinService.isAndroidLocalDevelopmentHost("conclave.acmvit.in"))
        XCTAssertFalse(SfuJoinService.isAndroidLocalDevelopmentHost("8.8.8.8"))
    }

    func testAndroidPhysicalDebugURLPolicyIgnoresOnlyPhysicalDeviceLocalTargets() throws {
        XCTAssertTrue(AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            "http://10.0.2.2:3000/api/sfu/join",
            isDebugRuntime: true,
            isEmulatorRuntime: false
        ))
        XCTAssertTrue(AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            "http://192.168.1.20:3000/api/sfu/join",
            isDebugRuntime: true,
            isEmulatorRuntime: false
        ))
        XCTAssertFalse(AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            "https://conclave.acmvit.in/api/sfu/join",
            isDebugRuntime: true,
            isEmulatorRuntime: false
        ))
        XCTAssertFalse(AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            "http://10.0.2.2:3000/api/sfu/join",
            isDebugRuntime: true,
            isEmulatorRuntime: true
        ))
        XCTAssertFalse(AndroidPhysicalDebugURLPolicy.shouldIgnoreLocalDevelopmentURL(
            "http://10.0.2.2:3000/api/sfu/join",
            isDebugRuntime: false,
            isEmulatorRuntime: false
        ))
    }

#if !SKIP
    func testAndroidManifestDoesNotCaptureWebOnlySignInLinks() throws {
        let manifest = try sourceFileContents("Android/app/src/main/AndroidManifest.xml")

        XCTAssertTrue(manifest.contains("android:pathPrefix=\"/w/\""))
        XCTAssertTrue(manifest.contains("android:pathPattern=\"/.*-.*-.*\""))
        XCTAssertFalse(manifest.contains("android:path=\"/sign-in\""))
        XCTAssertFalse(manifest.contains("android:pathPrefix=\"/sign-in/\""))
    }

    func testAndroidManifestRemovesLegacyExternalStoragePermissions() throws {
        let manifest = try sourceFileContents("Android/app/src/main/AndroidManifest.xml")

        XCTAssertTrue(manifest.contains("android:name=\"android.permission.READ_EXTERNAL_STORAGE\" tools:node=\"remove\""))
        XCTAssertTrue(manifest.contains("android:name=\"android.permission.WRITE_EXTERNAL_STORAGE\" tools:node=\"remove\""))
    }

    func testAndroidManifestRemovesTestOnlyPackageQueries() throws {
        let manifest = try sourceFileContents("Android/app/src/main/AndroidManifest.xml")

        XCTAssertTrue(manifest.contains("android:name=\"androidx.test.orchestrator\" tools:node=\"remove\""))
        XCTAssertTrue(manifest.contains("android:name=\"androidx.test.services\" tools:node=\"remove\""))
        XCTAssertTrue(manifest.contains("android:name=\"com.google.android.apps.common.testing.services\" tools:node=\"remove\""))
    }

    func testAndroidPolicyAckParserAcceptsObjectShapedChangedField() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        XCTAssertTrue(source.contains("private fun changedFlagField(obj: JSONObject, field: String): Boolean?"))
        XCTAssertTrue(source.contains("changed.length() > 0"))
        XCTAssertTrue(source.contains("changed = changedFlagField(obj, \"changed\")"))
    }

    func testAndroidJoinRoomResponseDecoderKeepsInitialPolicyFields() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        XCTAssertTrue(source.contains("isDmEnabled = boolField(obj, \"isDmEnabled\")"))
        XCTAssertTrue(source.contains("isReactionsDisabled = boolField(obj, \"isReactionsDisabled\")"))
        XCTAssertTrue(source.contains("meetingRequiresInviteCode = boolField(obj, \"meetingRequiresInviteCode\")"))
    }

    func testAndroidScreenShareCaptureUsesWebNetworkProfileBounds() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/WebRTCClient+Android.kt")

        XCTAssertTrue(source.contains("private data class ScreenShareCaptureProfile("))
        XCTAssertTrue(source.contains("private val screenShareOutgoingFairBps = 1_500_000.0"))
        XCTAssertTrue(source.contains("private val screenShareOutgoingPoorBps = 550_000.0"))
        XCTAssertTrue(source.contains("private val screenShareOutgoingEmergencyBps = 280_000.0"))
        XCTAssertTrue(source.contains("private fun deriveScreenSharePublishQuality("))
        XCTAssertTrue(source.contains("screenSharePublishQuality = screenSharePublishQuality"))
        XCTAssertTrue(source.contains("maxWidth = 3840"))
        XCTAssertTrue(source.contains("maxHeight = 2160"))
        XCTAssertTrue(source.contains("maxWidth = 2560"))
        XCTAssertTrue(source.contains("maxHeight = 1440"))
        XCTAssertTrue(source.contains("maxWidth = 1920"))
        XCTAssertTrue(source.contains("maxHeight = 1080"))
        XCTAssertTrue(source.contains("maxWidth = 1280"))
        XCTAssertTrue(source.contains("maxHeight = 720"))
        XCTAssertTrue(source.contains("private fun screenShareCaptureProfile("))
        XCTAssertTrue(source.contains("sourceWidth.toDouble() / cap.maxWidth.toDouble()"))
        XCTAssertTrue(source.contains("sourceHeight.toDouble() / cap.maxHeight.toDouble()"))
        XCTAssertTrue(source.contains("capturer.startCapture(\n                capture.width,\n                capture.height,\n                capture.maxFramerate,"))
        XCTAssertTrue(source.contains("screenCapturer?.changeCaptureFormat(\n                    capture.width,\n                    capture.height,\n                    capture.maxFramerate,"))
    }

    func testNativeScreenShareUsesSeparatePublishNetworkProfile() throws {
        let modelsSource = try sourceFileContents("Sources/Conclave/Core/Models/Models.swift")
        let viewModelSource = try sourceFileContents("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let iosWebRTCSource = try sourceFileContents("Sources/Conclave/Core/WebRTC/WebRTCClient.swift")
        let androidWebRTCSource = try sourceFileContents("Sources/Conclave/Skip/WebRTCClient+Android.kt")

        XCTAssertTrue(modelsSource.contains("let screenSharePublishQuality: ConnectionQuality"))
        XCTAssertTrue(iosWebRTCSource.contains("ScreenSharePublishProfilePolicy.quality("))
        XCTAssertTrue(viewModelSource.contains("private var screenSharePublishConnectionQuality: ConnectionQuality = .unknown"))
        XCTAssertTrue(viewModelSource.contains("ScreenSharePublishProfilePolicy.mostConstrained("))
        XCTAssertTrue(viewModelSource.contains("self.screenSharePublishConnectionQuality == quality"))
        XCTAssertTrue(viewModelSource.contains("initialReceiveConnectionQuality: receiveConnectionQuality"))
        XCTAssertTrue(iosWebRTCSource.contains("ScreenCaptureManager.shared.updateMaxFrameRate(\n                screenShareEncodingCap(connectionQuality: connectionQuality).maxFramerate"))
        XCTAssertTrue(iosWebRTCSource.contains("private func initialScreenConsumerPreference(\n        connectionQuality: ConnectionQuality"))
        XCTAssertTrue(iosWebRTCSource.contains("initialReceiveConnectionQuality: ConnectionQuality = .unknown"))
        XCTAssertTrue(iosWebRTCSource.contains("initialScreenConsumerPreference(\n                connectionQuality: initialReceiveConnectionQuality"))
        XCTAssertTrue(androidWebRTCSource.contains("screenShareCaptureProfile(\n                metrics.widthPixels,\n                metrics.heightPixels,\n                connectionQuality,"))
        XCTAssertTrue(androidWebRTCSource.contains("private fun initialScreenConsumerPreference(\n        connectionQuality: ConnectionQuality,"))
        XCTAssertTrue(androidWebRTCSource.contains("initialReceiveConnectionQuality: ConnectionQuality = ConnectionQuality.unknown"))
        XCTAssertTrue(androidWebRTCSource.contains("initialScreenConsumerPreference(\n                connectionQuality = initialReceiveConnectionQuality,"))
    }

    func testBrowserStateClearTearsDownSystemMediaConsumers() throws {
        let viewModelSource = try sourceFileContents("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let iosWebRTCSource = try sourceFileContents("Sources/Conclave/Core/WebRTC/WebRTCClient.swift")
        let androidWebRTCSource = try sourceFileContents("Sources/Conclave/Skip/WebRTCClient+Android.kt")

        XCTAssertTrue(viewModelSource.contains("private func clearBrowserMediaState()"))
        XCTAssertTrue(viewModelSource.contains("MeetingState.isBrowserAudioUserId(producer.producerUserId)"))
        XCTAssertTrue(viewModelSource.contains("MeetingState.isBrowserVideoUserId(producer.producerUserId)"))
        XCTAssertTrue(viewModelSource.contains("webRTCClient.closeConsumers(userIdPrefix: MeetingState.browserAudioUserIdPrefix)"))
        XCTAssertTrue(viewModelSource.contains("webRTCClient.closeConsumers(userIdPrefix: MeetingState.browserVideoUserIdPrefix)"))
        XCTAssertTrue(iosWebRTCSource.contains("func closeConsumers(userIdPrefix: String)"))
        XCTAssertTrue(iosWebRTCSource.contains("info.userId.hasPrefix(prefix) || info.trackKey.hasPrefix(prefix)"))
        XCTAssertTrue(androidWebRTCSource.contains("internal fun closeConsumers(userIdPrefix: String)"))
        XCTAssertTrue(androidWebRTCSource.contains("it.userId.startsWith(prefix) || it.trackKey.startsWith(prefix)"))
    }

    func testAndroidSocketManagerExposesBatchRoomPoliciesEvent() throws {
        let source = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        XCTAssertTrue(source.contains("val adminSetPolicies = SfuClientEvent.adminSetPolicies.rawValue"))
        XCTAssertTrue(source.contains("internal suspend fun setRoomPolicies("))
        XCTAssertTrue(source.contains("emit(SocketEvent.adminSetPolicies, payload)"))
    }

    func testNativeSocketManagersExposeRoomRoutingEvents() throws {
        let iosSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let androidSource = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        for source in [iosSource, androidSource] {
            XCTAssertTrue(source.contains("getRooms = SfuClientEvent.getRooms.rawValue"))
            XCTAssertTrue(source.contains("redirectUser = SfuClientEvent.redirectUser.rawValue"))
            XCTAssertTrue(source.contains("adminGetRoomsDetailed = SfuClientEvent.adminGetRoomsDetailed.rawValue"))
        }
        XCTAssertTrue(iosSource.contains("func getRooms() async throws -> [RoomInfo]"))
        XCTAssertTrue(iosSource.contains("func redirectUser(userId: String, newRoomId: String) async throws -> RedirectUserResponse"))
        XCTAssertTrue(androidSource.contains("internal suspend fun getRooms(): skip.lib.Array<RoomInfo>"))
        XCTAssertTrue(androidSource.contains("internal suspend fun redirectUser(userId: String, newRoomId: String): RedirectUserResponse"))
    }

    func testNativeSocketManagersExposeAdminStatusAndSnapshotAliases() throws {
        let iosSource = try sourceFileContents("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let androidSource = try sourceFileContents("Sources/Conclave/Skip/SocketIOManager+Android.kt")

        for source in [iosSource, androidSource] {
            XCTAssertTrue(source.contains("getRoomLockStatus = SfuClientEvent.getRoomLockStatus.rawValue"))
            XCTAssertTrue(source.contains("getChatLockStatus = SfuClientEvent.getChatLockStatus.rawValue"))
            XCTAssertTrue(source.contains("getDmEnabledStatus = SfuClientEvent.getDmEnabledStatus.rawValue"))
            XCTAssertTrue(source.contains("getTtsDisabledStatus = SfuClientEvent.getTtsDisabledStatus.rawValue"))
            XCTAssertTrue(source.contains("getReactionsDisabledStatus = SfuClientEvent.getReactionsDisabledStatus.rawValue"))
            XCTAssertTrue(source.contains("adminGetParticipants = SfuClientEvent.adminGetParticipants.rawValue"))
            XCTAssertTrue(source.contains("adminGetPendingUsers = SfuClientEvent.adminGetPendingUsers.rawValue"))
            XCTAssertTrue(source.contains("adminTransferHost = SfuClientEvent.adminTransferHost.rawValue"))
            XCTAssertTrue(source.contains("adminCloseRoom = SfuClientEvent.adminCloseRoom.rawValue"))
        }
        XCTAssertTrue(iosSource.contains("func transferHost(userId: String) async throws -> TransferHostResponse"))
        XCTAssertTrue(iosSource.contains("func closeRoom(message: String? = nil, delayMs: Int? = nil) async throws -> AdminEndRoomResponse"))
        XCTAssertTrue(androidSource.contains("internal suspend fun transferHost(userId: String): TransferHostResponse"))
        XCTAssertTrue(androidSource.contains("internal suspend fun closeRoom(message: String?, delayMs: Int?): AdminEndRoomResponse"))
    }

    func testDarwinPermissionPurposeStringsArePresentInAppAndExtensionPlists() throws {
        let appPlist = try sourcePlistDictionary("Darwin/Info.plist")
        let extensionPlist = try sourcePlistDictionary("Darwin/ScreenShareExtension/Info.plist")
        let purposeStringKeys = [
            "NSCameraUsageDescription",
            "NSMicrophoneUsageDescription",
            "NSBluetoothAlwaysUsageDescription",
            "NSBluetoothPeripheralUsageDescription",
            "NSLocalNetworkUsageDescription",
            "NSScreenCaptureUsageDescription",
            "NSPhotoLibraryUsageDescription",
            "NSPhotoLibraryAddUsageDescription",
            "NSLocationWhenInUseUsageDescription",
            "NSLocationAlwaysAndWhenInUseUsageDescription",
            "NSLocationAlwaysUsageDescription",
            "NSLocationUsageDescription",
            "NSFaceIDUsageDescription",
            "NSContactsUsageDescription",
            "NSCalendarsUsageDescription",
            "NSCalendarsFullAccessUsageDescription",
            "NSCalendarsWriteOnlyAccessUsageDescription",
            "NSRemindersUsageDescription",
            "NSRemindersFullAccessUsageDescription",
            "NSDocumentsFolderUsageDescription",
            "NSDownloadsFolderUsageDescription",
            "NSDesktopFolderUsageDescription",
            "NSNetworkVolumesUsageDescription",
            "NSRemovableVolumesUsageDescription",
            "NSSpeechRecognitionUsageDescription",
            "NSSiriUsageDescription",
            "NSFocusStatusUsageDescription",
            "NSMotionUsageDescription",
            "NSSensorKitUsageDescription",
            "NSUserTrackingUsageDescription",
            "NSUserNotificationsUsageDescription",
            "NFCReaderUsageDescription",
            "NSAppleMusicUsageDescription",
            "NSNearbyInteractionUsageDescription",
            "NSVideoSubscriberAccountUsageDescription",
            "NSHomeKitUsageDescription",
            "NSGKFriendListUsageDescription",
            "NSHealthShareUsageDescription",
            "NSHealthClinicalHealthRecordsShareUsageDescription",
            "NSHealthUpdateUsageDescription",
        ]

        try assertPurposeStrings(
            appPlist,
            keys: purposeStringKeys
        )
        let temporaryLocationPurposes = try XCTUnwrap(
            appPlist["NSLocationTemporaryUsageDescriptionDictionary"] as? [String: String]
        )
        XCTAssertFalse(
            temporaryLocationPurposes["MeetingLocationSharing", default: ""]
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
        )
        try assertPurposeStrings(
            extensionPlist,
            keys: purposeStringKeys
        )
        let extensionTemporaryLocationPurposes = try XCTUnwrap(
            extensionPlist["NSLocationTemporaryUsageDescriptionDictionary"] as? [String: String]
        )
        XCTAssertFalse(
            extensionTemporaryLocationPurposes["MeetingLocationSharing", default: ""]
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
        )
    }

    func testDarwinAppTargetUsesCheckedInInfoPlistForPurposeStrings() throws {
        let xcconfig = try sourceFileContents("Darwin/Conclave.xcconfig")
        let appPlist = try sourcePlistDictionary("Darwin/Info.plist")

        XCTAssertTrue(xcconfig.contains("INFOPLIST_FILE = Info.plist"))
        XCTAssertTrue(xcconfig.contains("GENERATE_INFOPLIST_FILE = NO"))
        XCTAssertFalse(
            xcconfig.contains("GENERATE_INFOPLIST_FILE = YES"),
            "The app target must not generate a replacement Info.plist without the checked-in purpose strings."
        )
        XCTAssertFalse(
            xcconfig.contains("INFOPLIST_KEY_"),
            "App metadata that affects archives should live in Darwin/Info.plist with the purpose strings."
        )

        let bundleKeys = [
            "CFBundleDevelopmentRegion",
            "CFBundleDisplayName",
            "CFBundleExecutable",
            "CFBundleIdentifier",
            "CFBundleInfoDictionaryVersion",
            "CFBundleName",
            "CFBundlePackageType",
            "CFBundleShortVersionString",
            "CFBundleVersion",
        ]
        for key in bundleKeys {
            XCTAssertNotNil(appPlist[key], "\(key) must be present when Info.plist generation is disabled")
        }
        XCTAssertNotNil(appPlist["UIApplicationSceneManifest"])
        XCTAssertEqual(appPlist["UIApplicationSupportsIndirectInputEvents"] as? Bool, true)
        XCTAssertNotNil(appPlist["UILaunchScreen"])
        XCTAssertEqual(appPlist["UIStatusBarStyle"] as? String, "UIStatusBarStyleDefault")
        let orientations = try XCTUnwrap(appPlist["UISupportedInterfaceOrientations"] as? [String])
        XCTAssertEqual(
            orientations,
            [
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
            ]
        )
    }

    func testDarwinPrivacyManifestDeclaresRequiredReasonApis() throws {
        try assertPrivacyManifestReasons(
            "Darwin/PrivacyInfo.xcprivacy",
            expectedReasons: [
                "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
                "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
                "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
                "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1", "85F4.1"],
            ]
        )
        try assertPrivacyManifestReasons(
            "Darwin/ScreenShareExtension/PrivacyInfo.xcprivacy",
            expectedReasons: [
                "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
                "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1", "85F4.1"],
            ]
        )
        try assertPrivacyManifestReasons(
            "Darwin/PrivacyManifests/ConclaveFramework.xcprivacy",
            expectedReasons: [
                "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
                "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
                "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
                "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1", "85F4.1"],
            ]
        )
        try assertPrivacyManifestReasons(
            "Darwin/PrivacyManifests/WebRTCFramework.xcprivacy",
            expectedReasons: [
                "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
                "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
                "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1", "85F4.1"],
            ]
        )
        try assertPrivacyManifestReasons(
            "Darwin/PrivacyManifests/MediasoupFramework.xcprivacy",
            expectedReasons: [
                "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
                "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
                "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1", "85F4.1"],
            ]
        )
    }

    func testDarwinEmbeddedFrameworkPrivacyPatchCoversMediaFrameworks() throws {
        let script = try String(contentsOf: sourceFileURL("Darwin/Scripts/apply-embedded-privacy-metadata.sh"))
        let project = try sourceFileContents("Darwin/Conclave.xcodeproj/project.pbxproj")

        XCTAssertTrue(script.contains("patch_host_app_plist"))
        XCTAssertTrue(script.contains("patch_conclave_framework"))
        XCTAssertTrue(script.contains("patch_webrtc_framework"))
        XCTAssertTrue(script.contains("patch_mediasoup_framework"))
        XCTAssertTrue(script.contains("patch_remaining_frameworks"))
        XCTAssertTrue(script.contains("patch_embedded_bundles"))
        XCTAssertTrue(script.contains("patch_embedded_app_extensions"))
        XCTAssertTrue(script.contains("${APP_INFO_PLIST}"))
        XCTAssertTrue(script.contains("${PLUGINS_DIR}"))
        XCTAssertTrue(script.contains("resign_code_bundle_if_needed \"$(dirname \""))
        XCTAssertTrue(script.contains("${FRAMEWORKS_DIR}/WebRTC.framework"))
        XCTAssertTrue(script.contains("${FRAMEWORKS_DIR}/Mediasoup.framework"))
        XCTAssertTrue(script.contains("\"*.bundle/Info.plist\""))
        XCTAssertTrue(script.contains("copy_privacy_manifest \"MediasoupFramework.xcprivacy\""))
        XCTAssertTrue(script.contains("\"NSCameraUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSMicrophoneUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSLocalNetworkUsageDescription\""))
        XCTAssertTrue(script.contains("NSLocationTemporaryUsageDescriptionDictionary"))
        XCTAssertTrue(script.contains("\"NSContactsUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSCalendarsFullAccessUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSCalendarsWriteOnlyAccessUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSRemindersFullAccessUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSDocumentsFolderUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSSpeechRecognitionUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSSiriUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSFocusStatusUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSMotionUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSSensorKitUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSUserTrackingUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSUserNotificationsUsageDescription\""))
        XCTAssertTrue(script.contains("\"NFCReaderUsageDescription\""))
        XCTAssertTrue(script.contains("\"NSHealthClinicalHealthRecordsShareUsageDescription\""))
        XCTAssertEqual(script.components(separatedBy: "set_all_purpose_strings \"${plist_path}\"").count - 1, 6)
        XCTAssertTrue(project.contains("DED5F813849FF18CBE9AFB5A /* Embed App Extensions */,\n\t\t\t\t8D0E0D6B2E5A4A71B57E90C1 /* Apply embedded privacy metadata */,"))
        XCTAssertTrue(project.contains("\"$(SRCROOT)/PrivacyManifests/MediasoupFramework.xcprivacy\""))
    }
#endif

    func testLocalVideoMirrorPolicyMirrorsOnlyFrontCamera() throws {
        XCTAssertTrue(LocalCameraFacing.front.shouldMirrorLocalVideo)
        XCTAssertFalse(LocalCameraFacing.back.shouldMirrorLocalVideo)
    }

    func testResolvedPreviewFacingDefaultsUnknownValuesToFrontCamera() throws {
        XCTAssertEqual(LocalCameraFacing.resolvedPreviewFacing(rawValue: "back"), .back)
        XCTAssertEqual(LocalCameraFacing.resolvedPreviewFacing(rawValue: " BACK "), .back)
        XCTAssertEqual(LocalCameraFacing.resolvedPreviewFacing(rawValue: "front"), .front)
        XCTAssertEqual(LocalCameraFacing.resolvedPreviewFacing(rawValue: "external"), .front)
        XCTAssertEqual(LocalCameraFacing.resolvedPreviewFacing(rawValue: ""), .front)
    }

}

#if !SKIP
private func parseMeetingCoreSfuEventRawValues(groupName: String) throws -> [String: String] {
    let source = try repoFileContents("packages/meeting-core/src/sfu-events.ts")
    let pattern = #"(?s)\b\#(groupName):\s*\{(.*?)\n\s*\}"#
    guard let groupBody = regexMatches(pattern: pattern, in: source).first?.first else {
        XCTFail("Could not locate SFU_EVENTS.\(groupName)")
        return [:]
    }

    return Dictionary(uniqueKeysWithValues: regexMatches(
        pattern: #"(\w+):\s*"([^"]+)""#,
        in: groupBody
    ).map { match in
        (match[0], match[1])
    })
}

private func parseSwiftSfuEventRawValues(enumName: String) throws -> [String: String] {
    let source = try sourceFileContents("Sources/Conclave/Core/Networking/SfuEvents.swift")
    guard let enumStart = source.range(of: "enum \(enumName): String {"),
          let enumEnd = source[enumStart.upperBound...].range(of: "\n}") else {
        XCTFail("Could not locate \(enumName) enum")
        return [:]
    }

    let enumBody = String(source[enumStart.upperBound..<enumEnd.lowerBound])
    return Dictionary(uniqueKeysWithValues: regexMatches(
        pattern: #"case\s+(\w+)\s*=\s*"([^"]+)""#,
        in: enumBody
    ).map { match in
        (match[0], match[1])
    })
}

private func parseSfuServerEventRawValues() throws -> [String: String] {
    try parseSwiftSfuEventRawValues(enumName: "SfuServerEvent")
}

private func parseSfuClientEventRawValues() throws -> [String: String] {
    try parseSwiftSfuEventRawValues(enumName: "SfuClientEvent")
}

private func mirroredClientEventRawValues(
    in relativePath: String,
    clientEventRawValues: [String: String]
) throws -> Set<String> {
    let source = try sourceFileContents(relativePath)
    let mirroredConstants = regexMatches(
        pattern: #"(?:static let|val)\s+\w+\s*=\s*SfuClientEvent\.(\w+)\.rawValue"#,
        in: source
    ).compactMap { match in
        clientEventRawValues[match[0]]
    }
    return Set(mirroredConstants)
}

private func registeredServerEventRawValues(
    in relativePath: String,
    serverEventRawValues: [String: String]
) throws -> Set<String> {
    let source = try sourceFileContents(relativePath)
    let socketEventConstants = Dictionary(uniqueKeysWithValues: regexMatches(
        pattern: #"(?:static let|val)\s+(\w+)\s*=\s*SfuServerEvent\.(\w+)\.rawValue"#,
        in: source
    ).compactMap { match -> (String, String)? in
        guard let rawValue = serverEventRawValues[match[1]] else { return nil }
        return (match[0], rawValue)
    })
    let registeredConstants = Set(regexMatches(
        pattern: #"socket\.on\(SocketEvent\.(\w+)"#,
        in: source
    ).map { $0[0] })

    return Set(registeredConstants.compactMap { socketEventConstants[$0] })
}

private func sourceFileContents(_ relativePath: String) throws -> String {
    try String(contentsOf: sourceFileURL(relativePath), encoding: .utf8)
}

private func sourcePlistDictionary(_ relativePath: String) throws -> NSDictionary {
    let data = try Data(contentsOf: sourceFileURL(relativePath))
    let object = try PropertyListSerialization.propertyList(from: data, format: nil)
    return try XCTUnwrap(object as? NSDictionary)
}

private func assertPurposeStrings(
    _ plist: NSDictionary,
    keys: [String],
    file: StaticString = #filePath,
    line: UInt = #line
) throws {
    for key in keys {
        let value = try XCTUnwrap(plist[key] as? String, "\(key) is missing", file: file, line: line)
        XCTAssertFalse(
            value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            "\(key) is empty",
            file: file,
            line: line
        )
        XCTAssertFalse(
            value.contains("$("),
            "\(key) must be a resolved user-facing purpose string",
            file: file,
            line: line
        )
    }
}

private func assertPrivacyManifestReasons(
    _ relativePath: String,
    expectedReasons: [String: [String]],
    file: StaticString = #filePath,
    line: UInt = #line
) throws {
    let privacyManifest = try sourcePlistDictionary(relativePath)
    let accessedApiTypes = try XCTUnwrap(
        privacyManifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
        file: file,
        line: line
    )
    let reasonsByCategory = Dictionary(uniqueKeysWithValues: accessedApiTypes.compactMap { entry -> (String, [String])? in
        guard
            let category = entry["NSPrivacyAccessedAPIType"] as? String,
            let reasons = entry["NSPrivacyAccessedAPITypeReasons"] as? [String]
        else {
            return nil
        }
        return (category, reasons)
    })

    for (category, reasons) in expectedReasons {
        XCTAssertEqual(reasonsByCategory[category], reasons, "\(category) in \(relativePath)", file: file, line: line)
    }
}

private func sourceFileURL(_ relativePath: String) -> URL {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot = testFile
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return packageRoot.appendingPathComponent(relativePath)
}

private func repoFileContents(_ relativePath: String) throws -> String {
    let testFile = URL(fileURLWithPath: #filePath)
    let repoRoot = testFile
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let url = repoRoot.appendingPathComponent(relativePath)
    return try String(contentsOf: url, encoding: .utf8)
}

private func regexMatches(pattern: String, in source: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let nsSource = source as NSString
    let range = NSRange(location: 0, length: nsSource.length)
    return regex.matches(in: source, range: range).map { result in
        (1..<result.numberOfRanges).compactMap { index in
            let range = result.range(at: index)
            guard range.location != NSNotFound else { return nil }
            return nsSource.substring(with: range)
        }
    }
}
#endif

@MainActor
private func replayPendingPreAckRoomEvents(
    on viewModel: MeetingViewModel,
    includeDeferredRoomState: Bool
) async {
    let replay: @MainActor (Bool) async -> Void = viewModel.replayPendingPreAckRoomEvents
    await replay(includeDeferredRoomState)
}

private func makeUnsignedJWT(payload: [String: Any]) throws -> String {
    let headerData = try JSONSerialization.data(withJSONObject: ["alg": "none", "typ": "JWT"])
    let payloadData = try JSONSerialization.data(withJSONObject: payload)
    return [
        base64URL(headerData),
        base64URL(payloadData),
        ""
    ].joined(separator: ".")
}

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

struct TestData: Codable, Hashable {
    var testModuleName: String
}
