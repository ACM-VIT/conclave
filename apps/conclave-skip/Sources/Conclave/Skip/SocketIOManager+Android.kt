package conclave.module

import android.os.Handler
import android.os.Looper
import io.socket.client.IO
import io.socket.client.Manager
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONArray
import org.json.JSONObject
import skip.foundation.*
import skip.lib.*
import skip.lib.Decodable
import skip.lib.Error
import skip.lib.ErrorException
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

private const val ACK_TIMEOUT_MS = 30_000L
private const val START_GAME_ACK_TIMEOUT_MS = 45_000L
private const val CONNECT_TIMEOUT_MS = 15_000L
private const val MAX_JOIN_ROOM_REDIRECTS = 1
private const val CLOSE_CONSUMER_MAX_ATTEMPTS = 4
private const val CLOSE_CONSUMER_RETRY_DELAY_MS = 500L
private const val CLOSE_CONSUMER_RETRY_WINDOW_MS = 30_000L

private class JoinRoomRedirectException(
    message: String,
    val redirectUrl: String
) : RuntimeException(message)

internal object SocketEvent {
    val joinRoom = SfuClientEvent.joinRoom.rawValue
    val getRouterRtpCapabilities = SfuClientEvent.getRouterRtpCapabilities.rawValue
    val createProducerTransport = SfuClientEvent.createProducerTransport.rawValue
    val createConsumerTransport = SfuClientEvent.createConsumerTransport.rawValue
    val connectProducerTransport = SfuClientEvent.connectProducerTransport.rawValue
    val connectConsumerTransport = SfuClientEvent.connectConsumerTransport.rawValue
    val restartIce = SfuClientEvent.restartIce.rawValue
    val produce = SfuClientEvent.produce.rawValue
    val consume = SfuClientEvent.consume.rawValue
    val resumeConsumer = SfuClientEvent.resumeConsumer.rawValue
    val setConsumerPreferences = SfuClientEvent.setConsumerPreferences.rawValue
    val closeConsumer = SfuClientEvent.closeConsumer.rawValue
    val getRooms = SfuClientEvent.getRooms.rawValue
    val getProducers = SfuClientEvent.getProducers.rawValue
    val toggleMute = SfuClientEvent.toggleMute.rawValue
    val toggleCamera = SfuClientEvent.toggleCamera.rawValue
    val closeProducer = SfuClientEvent.closeProducer.rawValue
    val sendChat = SfuClientEvent.sendChat.rawValue
    val conclaveAuthorize = SfuClientEvent.conclaveAuthorize.rawValue
    val conclaveAnswer = SfuClientEvent.conclaveAnswer.rawValue
    val sendReaction = SfuClientEvent.sendReaction.rawValue
    val setHandRaised = SfuClientEvent.setHandRaised.rawValue
    val updateDisplayName = SfuClientEvent.updateDisplayName.rawValue
    val lockRoom = SfuClientEvent.lockRoom.rawValue
    val lockChat = SfuClientEvent.lockChat.rawValue
    val setNoGuests = SfuClientEvent.setNoGuests.rawValue
    val setDmEnabled = SfuClientEvent.setDmEnabled.rawValue
    val setTtsDisabled = SfuClientEvent.setTtsDisabled.rawValue
    val setReactionsDisabled = SfuClientEvent.setReactionsDisabled.rawValue
    val getRoomLockStatus = SfuClientEvent.getRoomLockStatus.rawValue
    val getChatLockStatus = SfuClientEvent.getChatLockStatus.rawValue
    val getDmEnabledStatus = SfuClientEvent.getDmEnabledStatus.rawValue
    val getTtsDisabledStatus = SfuClientEvent.getTtsDisabledStatus.rawValue
    val getReactionsDisabledStatus = SfuClientEvent.getReactionsDisabledStatus.rawValue
    val adminSetPolicies = SfuClientEvent.adminSetPolicies.rawValue
    val admitUser = SfuClientEvent.admitUser.rawValue
    val rejectUser = SfuClientEvent.rejectUser.rawValue
    val admitAllPending = SfuClientEvent.adminAdmitAllPending.rawValue
    val rejectAllPending = SfuClientEvent.adminRejectAllPending.rawValue
    val kickUser = SfuClientEvent.kickUser.rawValue
    val closeRemoteProducer = SfuClientEvent.closeRemoteProducer.rawValue
    val muteAll = SfuClientEvent.muteAll.rawValue
    val closeAllVideo = SfuClientEvent.closeAllVideo.rawValue
    val promoteHost = SfuClientEvent.promoteHost.rawValue
    val redirectUser = SfuClientEvent.redirectUser.rawValue
    val adminTransferHost = SfuClientEvent.adminTransferHost.rawValue
    val adminMuteUser = SfuClientEvent.adminMuteUser.rawValue
    val adminMuteUserAudio = SfuClientEvent.adminMuteUserAudio.rawValue
    val adminCloseUserVideo = SfuClientEvent.adminCloseUserVideo.rawValue
    val adminCloseUserMedia = SfuClientEvent.adminCloseUserMedia.rawValue
    val adminStopUserScreenShare = SfuClientEvent.adminStopUserScreenShare.rawValue
    val adminStopAllScreenShare = SfuClientEvent.adminStopAllScreenShare.rawValue
    val adminClearRaisedHands = SfuClientEvent.adminClearRaisedHands.rawValue
    val adminBroadcastNotice = SfuClientEvent.adminBroadcastNotice.rawValue
    val adminGetRoomState = SfuClientEvent.adminGetRoomState.rawValue
    val adminGetRoomsDetailed = SfuClientEvent.adminGetRoomsDetailed.rawValue
    val adminGetParticipants = SfuClientEvent.adminGetParticipants.rawValue
    val adminGetPendingUsers = SfuClientEvent.adminGetPendingUsers.rawValue
    val adminGetAccessLists = SfuClientEvent.adminGetAccessLists.rawValue
    val adminAllowUsers = SfuClientEvent.adminAllowUsers.rawValue
    val adminBlockUsers = SfuClientEvent.adminBlockUsers.rawValue
    val adminUnblockUsers = SfuClientEvent.adminUnblockUsers.rawValue
    val adminRevokeAllowedUsers = SfuClientEvent.adminRevokeAllowedUsers.rawValue
    val adminCloseRoom = SfuClientEvent.adminCloseRoom.rawValue
    val adminEndRoom = SfuClientEvent.adminEndRoom.rawValue
    val meetingGetConfig = SfuClientEvent.meetingGetConfig.rawValue
    val meetingUpdateConfig = SfuClientEvent.meetingUpdateConfig.rawValue
    val webinarGetConfig = SfuClientEvent.webinarGetConfig.rawValue
    val webinarUpdateConfig = SfuClientEvent.webinarUpdateConfig.rawValue
    val webinarGenerateLink = SfuClientEvent.webinarGenerateLink.rawValue
    val webinarRotateLink = SfuClientEvent.webinarRotateLink.rawValue
    val browserLaunch = SfuClientEvent.browserLaunch.rawValue
    val browserNavigate = SfuClientEvent.browserNavigate.rawValue
    val browserClose = SfuClientEvent.browserClose.rawValue
    val browserGetState = SfuClientEvent.browserGetState.rawValue
    val browserActivity = SfuClientEvent.browserActivity.rawValue
    val appsOpen = SfuClientEvent.appsOpen.rawValue
    val appsClose = SfuClientEvent.appsClose.rawValue
    val appsLock = SfuClientEvent.appsLock.rawValue
    val appsGetState = SfuClientEvent.appsGetState.rawValue
    val appsYjsSync = SfuClientEvent.appsYjsSync.rawValue
    val appsYjsUpdate = SfuClientEvent.appsYjsUpdate.rawValue
    val appsAwareness = SfuClientEvent.appsAwareness.rawValue
    val gameList = SfuClientEvent.gameList.rawValue
    val gameStart = SfuClientEvent.gameStart.rawValue
    val gameMove = SfuClientEvent.gameMove.rawValue
    val gameEnd = SfuClientEvent.gameEnd.rawValue
    val gameGetState = SfuClientEvent.gameGetState.rawValue
    val gameVoteOpen = SfuClientEvent.gameVoteOpen.rawValue
    val gameVoteCast = SfuClientEvent.gameVoteCast.rawValue
    val gameVoteCancel = SfuClientEvent.gameVoteCancel.rawValue
    val transcriptGetToken = SfuClientEvent.transcriptGetToken.rawValue
    val transcriptSfuRelayStatus = SfuClientEvent.transcriptSfuRelayStatus.rawValue
    val transcriptSfuRelayStart = SfuClientEvent.transcriptSfuRelayStart.rawValue
    val transcriptSfuRelayStop = SfuClientEvent.transcriptSfuRelayStop.rawValue

    val userJoined = SfuServerEvent.userJoined.rawValue
    val userLeft = SfuServerEvent.userLeft.rawValue
    val displayNameSnapshot = SfuServerEvent.displayNameSnapshot.rawValue
    val displayNameUpdated = SfuServerEvent.displayNameUpdated.rawValue
    val newProducer = SfuServerEvent.newProducer.rawValue
    val producerClosed = SfuServerEvent.producerClosed.rawValue
    val consumerTelemetry = SfuServerEvent.consumerTelemetry.rawValue
    val chatMessage = SfuServerEvent.chatMessage.rawValue
    val conclaveMessage = SfuServerEvent.conclaveMessage.rawValue
    val chatHistorySnapshot = SfuServerEvent.chatHistorySnapshot.rawValue
    val reaction = SfuServerEvent.reaction.rawValue
    val handRaised = SfuServerEvent.handRaised.rawValue
    val handRaisedSnapshot = SfuServerEvent.handRaisedSnapshot.rawValue
    val roomLockChanged = SfuServerEvent.roomLockChanged.rawValue
    val chatLockChanged = SfuServerEvent.chatLockChanged.rawValue
    val noGuestsChanged = SfuServerEvent.noGuestsChanged.rawValue
    val dmStateChanged = SfuServerEvent.dmStateChanged.rawValue
    val ttsDisabledChanged = SfuServerEvent.ttsDisabledChanged.rawValue
    val reactionsDisabledChanged = SfuServerEvent.reactionsDisabledChanged.rawValue
    val userRequestedJoin = SfuServerEvent.userRequestedJoin.rawValue
    val pendingUsersSnapshot = SfuServerEvent.pendingUsersSnapshot.rawValue
    val userAdmitted = SfuServerEvent.userAdmitted.rawValue
    val userRejected = SfuServerEvent.userRejected.rawValue
    val pendingUserLeft = SfuServerEvent.pendingUserLeft.rawValue
    val joinApproved = SfuServerEvent.joinApproved.rawValue
    val joinRejected = SfuServerEvent.joinRejected.rawValue
    val waitingRoomStatus = SfuServerEvent.waitingRoomStatus.rawValue
    val hostAssigned = SfuServerEvent.hostAssigned.rawValue
    val hostChanged = SfuServerEvent.hostChanged.rawValue
    val adminUsersChanged = SfuServerEvent.adminUsersChanged.rawValue
    val participantMuted = SfuServerEvent.participantMuted.rawValue
    val participantCameraOff = SfuServerEvent.participantCameraOff.rawValue
    val participantConnectionState = SfuServerEvent.participantConnectionState.rawValue
    val setVideoQuality = SfuServerEvent.setVideoQuality.rawValue
    val redirect = SfuServerEvent.redirect.rawValue
    val kicked = SfuServerEvent.kicked.rawValue
    val roomClosed = SfuServerEvent.roomClosed.rawValue
    val roomEnded = SfuServerEvent.roomEnded.rawValue
    val serverRestarting = SfuServerEvent.serverRestarting.rawValue
    val adminNotice = SfuServerEvent.adminNotice.rawValue
    val adminMediaEnforced = SfuServerEvent.adminMediaEnforced.rawValue
    val adminBulkMediaEnforced = SfuServerEvent.adminBulkMediaEnforced.rawValue
    val adminHandsCleared = SfuServerEvent.adminHandsCleared.rawValue
    val adminProducerClosed = SfuServerEvent.adminProducerClosed.rawValue
    val adminRoomStateChanged = SfuServerEvent.adminRoomStateChanged.rawValue
    val meetingConfigChanged = SfuServerEvent.meetingConfigChanged.rawValue
    val webinarConfigChanged = SfuServerEvent.webinarConfigChanged.rawValue
    val webinarAttendeeCountChanged = SfuServerEvent.webinarAttendeeCountChanged.rawValue
    val webinarFeedChanged = SfuServerEvent.webinarFeedChanged.rawValue
    val webinarParticipantJoined = SfuServerEvent.webinarParticipantJoined.rawValue
    val browserState = SfuServerEvent.browserState.rawValue
    val browserClosed = SfuServerEvent.browserClosed.rawValue
    val appsState = SfuServerEvent.appsState.rawValue
    val appsYjsServerUpdate = SfuServerEvent.appsYjsUpdate.rawValue
    val appsServerAwareness = SfuServerEvent.appsAwareness.rawValue
    val gameState = SfuServerEvent.gameState.rawValue
    val gameView = SfuServerEvent.gameView.rawValue
    val gameSnapshot = SfuServerEvent.gameSnapshot.rawValue
    val gameEnded = SfuServerEvent.gameEnded.rawValue
    val gameVote = SfuServerEvent.gameVote.rawValue
}

/// Raw consume-response fields, carrying rtpParameters as the verbatim JSON
/// string mediasoup gave us rather than a re-encoded Swift struct. Skip's
/// JSONEncoder cannot encode the `[String: String]` codec `parameters` map
/// (it throws "Tuple2 cannot be cast to Encodable"), so any round-trip of
/// RtpParameters/RtpCapabilities through the Codable structs crashes on
/// Android. We therefore keep these blobs as raw JSON end-to-end.
internal class ConsumeRawResult(
    internal val id: String,
    internal val producerId: String,
    internal val kind: String,
    internal val rtpParametersJson: String
)

internal class SocketIOManager {
    internal var isConnected = false
        private set
    internal var connectionError: Error? = null
        private set

    /// The router's RTP capabilities exactly as the server sent them in the
    /// joinRoom ack. Passed verbatim to mediasoup `Device.load()` — see
    /// ConsumeRawResult for why we avoid re-encoding the Codable struct.
    internal var routerRtpCapabilitiesJson: String? = null
        private set

    internal var onConnected: (() -> Unit)? = null
    internal var onDisconnected: ((String?) -> Unit)? = null
    internal var onError: ((Error) -> Unit)? = null
    internal var onReconnecting: ((Int) -> Unit)? = null
    internal var onReconnected: (() -> Unit)? = null
    internal var onReconnectFailed: (() -> Unit)? = null

    internal var onWaitingRoomStatus: ((WaitingRoomStatusNotification) -> Unit)? = null
    internal var onJoinApproved: ((JoinDecisionNotification) -> Unit)? = null
    internal var onJoinRejected: ((JoinDecisionNotification) -> Unit)? = null
    internal var onHostAssigned: ((HostAssignedNotification) -> Unit)? = null
    internal var onHostChanged: ((HostChangedNotification) -> Unit)? = null
    internal var onAdminUsersChanged: ((AdminUsersChangedNotification) -> Unit)? = null
    internal var onKicked: ((KickedNotification) -> Unit)? = null
    internal var onRoomClosed: ((RoomClosedNotification) -> Unit)? = null
    internal var onRoomEnded: ((RoomEndedNotification) -> Unit)? = null
    internal var onServerRestarting: ((ServerRestartingNotification) -> Unit)? = null
    internal var onAdminNotice: ((AdminNoticeNotification) -> Unit)? = null
    internal var onAdminHandsCleared: ((AdminHandsClearedNotification) -> Unit)? = null
    internal var onAdminRoomStateChanged: ((AdminRoomStateChangedNotification) -> Unit)? = null
    internal var onMeetingConfigChanged: ((MeetingConfigSnapshot) -> Unit)? = null
    internal var onWebinarConfigChanged: ((WebinarConfigSnapshot) -> Unit)? = null
    internal var onWebinarAttendeeCountChanged: ((WebinarAttendeeCountChangedNotification) -> Unit)? = null
    internal var onWebinarFeedChanged: ((WebinarFeedChangedNotification) -> Unit)? = null
    internal var onWebinarParticipantJoined: ((WebinarParticipantJoinedNotification) -> Unit)? = null
    internal var onBrowserState: ((BrowserStateNotification) -> Unit)? = null
    internal var onBrowserClosed: ((BrowserClosedNotification) -> Unit)? = null
    internal var onAppsState: ((AppsStateNotification) -> Unit)? = null
    internal var onAppsYjsUpdate: ((AppsYjsUpdateNotification) -> Unit)? = null
    internal var onAppsAwareness: ((AppsAwarenessNotification) -> Unit)? = null
    internal var onGameState: ((GamePublicState) -> Unit)? = null
    internal var onGameView: ((GamePlayerViewNotification) -> Unit)? = null
    internal var onGameSnapshot: ((GameStateResponse) -> Unit)? = null
    internal var onGameEnded: ((GameEndedNotification) -> Unit)? = null
    internal var onGameVote: ((GameVoteState?) -> Unit)? = null

    internal var onUserJoined: ((UserJoinedNotification) -> Unit)? = null
    internal var onUserLeft: ((UserLeftNotification) -> Unit)? = null
    internal var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Unit)? = null
    internal var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Unit)? = null
    internal var onParticipantMuted: ((ParticipantMutedNotification) -> Unit)? = null
    internal var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Unit)? = null
    internal var onParticipantConnectionState: ((ParticipantConnectionStateNotification) -> Unit)? = null

    internal var onNewProducer: ((ProducerInfo) -> Unit)? = null
    internal var onProducerClosed: ((ProducerClosedNotification) -> Unit)? = null
    internal var onConsumerTelemetry: ((ConsumerTelemetryNotification) -> Unit)? = null

    internal var onChatMessage: ((ChatMessage) -> Unit)? = null
    internal var onChatHistorySnapshot: ((ChatHistorySnapshotNotification) -> Unit)? = null
    internal var onReaction: ((Reaction) -> Unit)? = null

    internal var onHandRaised: ((HandRaisedNotification) -> Unit)? = null
    internal var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Unit)? = null

    internal var onRoomLockChanged: ((RoomLockChangedNotification) -> Unit)? = null
    internal var onChatLockChanged: ((ChatLockChangedNotification) -> Unit)? = null
    internal var onNoGuestsChanged: ((NoGuestsChangedNotification) -> Unit)? = null
    internal var onDmStateChanged: ((DmStateChangedNotification) -> Unit)? = null
    internal var onTtsDisabledChanged: ((TtsDisabledChangedNotification) -> Unit)? = null
    internal var onReactionsDisabledChanged: ((ReactionsDisabledChangedNotification) -> Unit)? = null
    internal var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Unit)? = null
    internal var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Unit)? = null
    internal var onPendingUserChanged: ((PendingUserChangedNotification) -> Unit)? = null
    internal var onRedirect: ((RedirectNotification) -> Unit)? = null
    internal var onSetVideoQuality: ((SetVideoQualityNotification) -> Unit)? = null
    internal var onAdminMediaEnforced: ((AdminMediaEnforcedNotification) -> Unit)? = null
    internal var onAdminBulkMediaEnforced: ((AdminBulkMediaEnforcedNotification) -> Unit)? = null

    private var manager: Manager? = null
    private var socket: Socket? = null
    private var isIntentionalDisconnect = false
    private var didAttemptReconnect = false
    private var activeRoomId: String? = null
    private var activeRoomAliases: Set<String> = emptySet()
    private var pendingRoomAliases: Set<String> = emptySet()
    private var pendingResolvedRoomAlias: String? = null
    private var activeAuthToken: String? = null
    private var activeSfuURL: String? = null
    private var pendingConnectFailure: ((ErrorException) -> Unit)? = null
    private var connectAttemptSequence = 0L
    private var pendingConnectAttemptId: Long? = null
    private val closeConsumerHandler = Handler(Looper.getMainLooper())

    internal suspend fun connect(sfuURL: String, token: String) {
        val normalizedToken = token.trim()
        val normalizedSfuURL = sfuURL.trim()

        if (normalizedToken.isBlank()) {
            val error = ErrorException("Missing token for SFU connection")
            connectionError = error
            onError?.invoke(error)
            throw error
        }
        if (normalizedSfuURL.isBlank()) {
            val error = ErrorException("Missing SFU URL")
            connectionError = error
            onError?.invoke(error)
            throw error
        }
        if (isConnected) {
            if (activeAuthToken == normalizedToken && activeSfuURL == normalizedSfuURL) {
                return
            }
            disconnect()
        }
        if (socket != null || manager != null) {
            disconnect()
        }

        activeAuthToken = normalizedToken
        activeSfuURL = normalizedSfuURL
        isIntentionalDisconnect = false

        val opts = IO.Options().apply {
            forceNew = true
            reconnection = true
            reconnectionAttempts = 8
            reconnectionDelay = 1000
            reconnectionDelayMax = 5000
            query = "token=${java.net.URLEncoder.encode(normalizedToken, "UTF-8")}"
            auth = mapOf("token" to normalizedToken)
        }

        val socketManager = this
        val currentSocket = IO.socket(normalizedSfuURL, opts)
        val currentManager = currentSocket.io()
        socket = currentSocket
        manager = currentManager
        connectAttemptSequence += 1
        val connectAttemptId = connectAttemptSequence
        pendingConnectAttemptId = connectAttemptId
        registerEventHandlers(currentSocket)

        var timedOutCurrentConnect = false
        try {
            withTimeout(CONNECT_TIMEOUT_MS) {
                suspendCancellableCoroutine<Unit> { cont ->
                    var didResume = false

                    fun isCurrentConnectAttempt(): Boolean {
                        return socketManager.socket === currentSocket &&
                            socketManager.manager === currentManager &&
                            pendingConnectAttemptId == connectAttemptId
                    }

                    fun cleanupFailedConnect() {
                        val ownsActiveAttempt = isCurrentConnectAttempt()
                        if (ownsActiveAttempt) {
                            pendingConnectFailure = null
                        }
                        currentSocket.off()
                        currentManager.off()
                        currentSocket.disconnect()
                        if (ownsActiveAttempt) {
                            socket = null
                            manager = null
                            isConnected = false
                            activeRoomId = null
                            activeRoomAliases = emptySet()
                            pendingRoomAliases = emptySet()
                            pendingResolvedRoomAlias = null
                            activeAuthToken = null
                            activeSfuURL = null
                            pendingConnectAttemptId = null
                            routerRtpCapabilitiesJson = null
                        }
                    }

                    fun fail(error: ErrorException) {
                        if (didResume) return
                        didResume = true
                        cleanupFailedConnect()
                        cont.resumeWithException(error)
                    }

                    pendingConnectFailure = { error ->
                        fail(error)
                    }

                    cont.invokeOnCancellation {
                        if (!didResume) {
                            didResume = true
                            timedOutCurrentConnect = isCurrentConnectAttempt()
                            cleanupFailedConnect()
                        }
                    }

                    currentSocket.on(Socket.EVENT_CONNECT, Emitter.Listener {
                        if (socketManager.socket !== currentSocket) return@Listener
                        isConnected = true
                        connectionError = null
                        didAttemptReconnect = false
                        onConnected?.invoke()
                        if (!didResume) {
                            didResume = true
                            if (pendingConnectAttemptId == connectAttemptId) {
                                pendingConnectFailure = null
                                pendingConnectAttemptId = null
                            }
                            cont.resume(Unit)
                        }
                    })

                    currentSocket.on(Socket.EVENT_DISCONNECT, Emitter.Listener { args ->
                        if (socketManager.socket !== currentSocket) return@Listener
                        isConnected = false
                        val reason = args.firstOrNull()?.toString()
                        if (!isIntentionalDisconnect) {
                            onDisconnected?.invoke(reason)
                        }
                        if (!didResume) {
                            val suffix = reason?.let { ": $it" } ?: ""
                            fail(ErrorException("Socket disconnected before connection completed$suffix"))
                        }
                    })

                    currentManager.on(Manager.EVENT_ERROR, Emitter.Listener { args ->
                        if (socketManager.socket !== currentSocket || socketManager.manager !== currentManager) return@Listener
                        val error = ErrorException(socketClientErrorMessage(args.firstOrNull(), "Socket error"))
                        connectionError = error
                        onError?.invoke(error)
                        fail(error)
                    })

                    currentSocket.on(Socket.EVENT_CONNECT_ERROR, Emitter.Listener { args ->
                        if (socketManager.socket !== currentSocket) return@Listener
                        val error = ErrorException(socketClientErrorMessage(args.firstOrNull(), "Connection error"))
                        connectionError = error
                        onError?.invoke(error)
                        fail(error)
                    })

                    currentManager.on(Manager.EVENT_RECONNECT_ATTEMPT, Emitter.Listener { args ->
                        if (socketManager.socket !== currentSocket || socketManager.manager !== currentManager) return@Listener
                        val attempt = (args.firstOrNull() as? Number)?.toInt() ?: 0
                        didAttemptReconnect = true
                        onReconnecting?.invoke(attempt)
                    })

                    currentManager.on(Manager.EVENT_RECONNECT, Emitter.Listener {
                        if (socketManager.socket !== currentSocket || socketManager.manager !== currentManager) return@Listener
                        didAttemptReconnect = false
                        onReconnected?.invoke()
                    })

                    currentManager.on(Manager.EVENT_RECONNECT_FAILED, Emitter.Listener {
                        if (socketManager.socket !== currentSocket || socketManager.manager !== currentManager) return@Listener
                        if (didAttemptReconnect && !isIntentionalDisconnect) {
                            didAttemptReconnect = false
                            onReconnectFailed?.invoke()
                        }
                    })

                    currentSocket.connect()
                }
            }
        } catch (_: TimeoutCancellationException) {
            val error = ErrorException("Timed out waiting for SFU connection")
            if (timedOutCurrentConnect ||
                (socket === currentSocket && manager === currentManager && pendingConnectAttemptId == connectAttemptId)
            ) {
                connectionError = error
                onError?.invoke(error)
            }
            throw error
        }
    }

    internal fun disconnect() {
        isIntentionalDisconnect = true
        pendingConnectFailure?.invoke(ErrorException("Socket disconnected before connection completed"))
        pendingConnectFailure = null
        pendingConnectAttemptId = null
        val socketToDisconnect = socket
        socketToDisconnect?.disconnect()
        socketToDisconnect?.off()
        manager?.off()
        socket = null
        manager = null
        activeRoomId = null
        activeRoomAliases = emptySet()
        pendingRoomAliases = emptySet()
        pendingResolvedRoomAlias = null
        activeAuthToken = null
        activeSfuURL = null
        closeConsumerHandler.removeCallbacksAndMessages(null)
        routerRtpCapabilitiesJson = null
        isConnected = false
    }

    internal suspend fun joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Boolean,
        meetingInviteCode: String? = null,
        webinarInviteCode: String? = null
    ): JoinRoomResponse {
        val request = JoinRoomRequest(
            roomId = roomId,
            sessionId = sessionId,
            displayName = displayName,
            ghost = isGhost,
            webinarInviteCode = webinarInviteCode,
            meetingInviteCode = meetingInviteCode
        )

        var followedRedirects = 0
        while (true) {
            try {
                return joinRoomOnce(request, roomId)
            } catch (redirect: JoinRoomRedirectException) {
                if (followedRedirects >= MAX_JOIN_ROOM_REDIRECTS) {
                    throw ErrorException(redirect.message ?: "Room is hosted by another SFU instance.")
                }
                val token = activeAuthToken
                    ?: throw ErrorException("Missing token for routed SFU connection")
                followedRedirects += 1
                val redirectedURL = SfuJoinService.platformReachableURLString(redirect.redirectUrl)
                disconnect()
                connect(redirectedURL, token)
            }
        }
    }

    private suspend fun joinRoomOnce(request: JoinRoomRequest, requestedRoomId: String): JoinRoomResponse {
        activeRoomId = null
        activeRoomAliases = emptySet()
        pendingRoomAliases = roomAliasSet(requestedRoomId = requestedRoomId, resolvedRoomId = null)
        pendingResolvedRoomAlias = null
        routerRtpCapabilitiesJson = null

        try {
            val data = emitAllowingServerError(SocketEvent.joinRoom, request)
            val errorObject = jsonObject(dataToString(data))
            val errorMessage = errorObject?.let { stringField(it, "error") }
            if (errorMessage != null) {
                pendingRoomAliases = emptySet()
                pendingResolvedRoomAlias = null
                val redirectUrl = normalizeJoinRedirectURL(errorObject?.let { stringField(it, "redirectUrl") })
                if (redirectUrl != null) {
                    throw JoinRoomRedirectException(errorMessage, redirectUrl)
                }
                throw ErrorException(errorMessage)
            }

            // Stash the router rtpCapabilities verbatim BEFORE decoding — mediasoup
            // Device.load() wants this JSON, and re-encoding the decoded struct
            // crashes Skip's JSONEncoder (AnyCodable codec params -> Tuple2).
            extractRawObjectField(data, "rtpCapabilities")?.let { routerRtpCapabilitiesJson = it }
            val response = decodeJoinRoomResponse(data)
            val resolvedRoomId = response.roomId ?: requestedRoomId
            if (response.status == "waiting") {
                activeRoomId = null
                activeRoomAliases = emptySet()
                pendingRoomAliases = roomAliasSet(requestedRoomId = requestedRoomId, resolvedRoomId = resolvedRoomId)
                pendingResolvedRoomAlias = null
            } else {
                activeRoomId = resolvedRoomId
                activeRoomAliases = roomAliasSet(requestedRoomId = requestedRoomId, resolvedRoomId = resolvedRoomId)
                pendingRoomAliases = emptySet()
                pendingResolvedRoomAlias = null
            }
            return response
        } catch (error: Throwable) {
            pendingRoomAliases = emptySet()
            pendingResolvedRoomAlias = null
            routerRtpCapabilitiesJson = null
            throw error
        }
    }

    internal suspend fun createProducerTransport(): TransportResponse {
        // These two SFU handlers take ONLY an ack callback (no data arg):
        //   socket.on("createProducerTransport", (callback) => …)
        // Emitting an empty `{}` payload first would shift the args so the
        // server binds `callback` to the object and respond() silently no-ops,
        // hanging the client. Emit with the ack alone, matching the web client.
        val data = emitAckOnly(SocketEvent.createProducerTransport)
        return JSONDecoder().decode(TransportResponse::class, from = data)
    }

    internal suspend fun createConsumerTransport(): TransportResponse {
        val data = emitAckOnly(SocketEvent.createConsumerTransport)
        return JSONDecoder().decode(TransportResponse::class, from = data)
    }

    internal suspend fun connectProducerTransport(transportId: String, dtlsParameters: DtlsParameters) {
        val request = ConnectTransportRequest(transportId = transportId, dtlsParameters = dtlsParameters)
        emit(SocketEvent.connectProducerTransport, request)
    }

    internal suspend fun connectConsumerTransport(transportId: String, dtlsParameters: DtlsParameters) {
        val request = ConnectTransportRequest(transportId = transportId, dtlsParameters = dtlsParameters)
        emit(SocketEvent.connectConsumerTransport, request)
    }

    internal suspend fun restartIce(transport: String, transportId: String?): RestartIceResponse {
        val request = RestartIceRequest(transport = transport, transportId = transportId)
        val data = emit(SocketEvent.restartIce, request)
        return JSONDecoder().decode(RestartIceResponse::class, from = data)
    }

    /// Send the producer's rtpParameters (the verbatim JSON mediasoup handed us
    /// in the Transport's onProduce listener) without round-tripping it through
    /// the RtpParameters Codable struct, which Skip's JSONEncoder cannot encode.
    /// The request is assembled as a JSONObject so `toSocketPayload` passes it
    /// through untouched.
    internal suspend fun produceRaw(
        transportId: String,
        kind: String,
        rtpParametersJson: String,
        type: ProducerType,
        paused: Boolean
    ): String {
        val request = JSONObject()
        request.put("transportId", transportId)
        request.put("kind", kind)
        request.put("rtpParameters", JSONObject(rtpParametersJson))
        val appData = JSONObject()
        appData.put("type", type.rawValue)
        appData.put("paused", paused)
        request.put("appData", appData)
        val data = emit(SocketEvent.produce, request)
        val response = JSONDecoder().decode(ProduceResponse::class, from = data)
        return response.producerId
    }

    /// Consume using the router rtpCapabilities verbatim JSON, and return the
    /// server's rtpParameters as raw JSON for mediasoup `RecvTransport.consume()`.
    /// Same rationale as produceRaw: avoid the AnyCodable encode crash.
    internal suspend fun consumeRaw(
        producerId: String,
        rtpCapabilitiesJson: String,
        transportId: String,
        preferredSpatialLayer: Int? = null,
        preferredTemporalLayer: Int? = null,
        priority: Int? = null
    ): ConsumeRawResult {
        val request = JSONObject()
        request.put("transportId", transportId)
        request.put("producerId", producerId)
        request.put("rtpCapabilities", JSONObject(rtpCapabilitiesJson))
        if (preferredSpatialLayer != null) {
            val preferredLayers = JSONObject().put("spatialLayer", preferredSpatialLayer)
            if (preferredTemporalLayer != null) {
                preferredLayers.put("temporalLayer", preferredTemporalLayer)
            }
            request.put("preferredLayers", preferredLayers)
        }
        if (priority != null) {
            request.put("priority", priority)
        }
        val data = emit(SocketEvent.consume, request)
        val obj = JSONObject(dataToString(data))
        return ConsumeRawResult(
            id = obj.getString("id"),
            producerId = obj.getString("producerId"),
            kind = obj.getString("kind"),
            rtpParametersJson = obj.getJSONObject("rtpParameters").toString()
        )
    }

    internal suspend fun resumeConsumer(consumerId: String, requestKeyFrame: Boolean = false) {
        val request = ResumeConsumerRequest(consumerId = consumerId, requestKeyFrame = requestKeyFrame)
        emit(SocketEvent.resumeConsumer, request)
    }

    internal fun closeConsumer(consumerId: String) {
        val trimmedConsumerId = consumerId.trim()
        if (!isConnected || trimmedConsumerId.isEmpty()) return
        closeConsumerWithRetry(
            consumerId = trimmedConsumerId,
            attempt = 0,
            startedAtMs = System.currentTimeMillis()
        )
    }

    internal suspend fun setConsumerPreferences(
        consumerId: String,
        spatialLayer: Int? = null,
        temporalLayer: Int? = null,
        priority: Int? = null,
        paused: Boolean? = null,
        requestKeyFrame: Boolean = false
    ) {
        val trimmedConsumerId = consumerId.trim()
        if (trimmedConsumerId.isEmpty()) return

        val payload = JSONObject().put("consumerId", trimmedConsumerId)
        if (spatialLayer != null) {
            val preferredLayers = JSONObject().put("spatialLayer", spatialLayer)
            if (temporalLayer != null) {
                preferredLayers.put("temporalLayer", temporalLayer)
            }
            payload.put("preferredLayers", preferredLayers)
        }
        if (priority != null) {
            payload.put("priority", priority)
        }
        if (paused != null) {
            payload.put("paused", paused)
        }
        if (requestKeyFrame) {
            payload.put("requestKeyFrame", true)
        }

        emit(SocketEvent.setConsumerPreferences, payload)
    }

    /// Snapshot the room's current producers (producer-sync safety net). The SFU
    /// handler takes ONLY an ack callback — emit with no payload via emitAckOnly.
    /// Returns the whole response object; the caller iterates `.producers` (a
    /// bare list return trips Skip's Array/List bridging). Throws on failure;
    /// the caller's do/catch swallows it.
    internal suspend fun getProducers(): GetProducersResponse {
        val data = emitAckOnly(SocketEvent.getProducers)
        return decodeGetProducersResponse(data)
    }

    internal suspend fun getRooms(): skip.lib.Array<RoomInfo> {
        val data = emitAckOnly(SocketEvent.getRooms)
        return decodeRoomListResponse(data).rooms
    }

    internal suspend fun toggleMute(producerId: String, paused: Boolean) {
        val request = ToggleMediaRequest(producerId = producerId, paused = paused)
        emit(SocketEvent.toggleMute, request)
    }

    internal suspend fun toggleCamera(producerId: String, paused: Boolean) {
        val request = ToggleMediaRequest(producerId = producerId, paused = paused)
        emit(SocketEvent.toggleCamera, request)
    }

    internal suspend fun closeProducer(producerId: String) {
        emit(SocketEvent.closeProducer, mapOf("producerId" to producerId))
    }

    internal suspend fun sendChat(
        content: String,
        gif: ChatGifAttachment? = null,
        recipient: String? = null,
        replyTo: ChatReplyPreview? = null
    ): ChatMessage {
        val request = SendChatRequest(content = content, gif = gif, recipient = recipient, replyTo = replyTo)
        val data = emit(SocketEvent.sendChat, request)
        val response = JSONDecoder().decode(SendChatResponse::class, from = data)
        val notification = response.message ?: throw ErrorException("Missing chat message acknowledgement.")
        return notification.toChatMessage(activeRoomId)
    }

    internal suspend fun sendReaction(emoji: String?, kind: String?, value: String?, label: String?) {
        val request = SendReactionRequest(emoji = emoji, kind = kind, value = value, label = label)
        emit(SocketEvent.sendReaction, request)
    }

    internal suspend fun setHandRaised(raised: Boolean) {
        val request = SetHandRaisedRequest(raised = raised)
        emit(SocketEvent.setHandRaised, request)
    }

    internal suspend fun updateDisplayName(name: String) {
        emit(SocketEvent.updateDisplayName, mapOf("displayName" to name))
    }

    internal suspend fun lockRoom(locked: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.lockRoom, mapOf("locked" to locked))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun lockChat(locked: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.lockChat, mapOf("locked" to locked))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun setNoGuests(noGuests: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.setNoGuests, mapOf("noGuests" to noGuests))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun setDmEnabled(enabled: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.setDmEnabled, mapOf("enabled" to enabled))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun setTtsDisabled(disabled: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.setTtsDisabled, mapOf("disabled" to disabled))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun setReactionsDisabled(disabled: Boolean): RoomPolicyMutationResponse {
        val data = emit(SocketEvent.setReactionsDisabled, mapOf("disabled" to disabled))
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun setRoomPolicies(
        locked: Boolean? = null,
        noGuests: Boolean? = null,
        chatLocked: Boolean? = null,
        ttsDisabled: Boolean? = null,
        dmEnabled: Boolean? = null,
        reactionsDisabled: Boolean? = null
    ): RoomPolicyMutationResponse {
        val payload = JSONObject()
        if (locked != null) payload.put("locked", locked)
        if (noGuests != null) payload.put("noGuests", noGuests)
        if (chatLocked != null) payload.put("chatLocked", chatLocked)
        if (ttsDisabled != null) payload.put("ttsDisabled", ttsDisabled)
        if (dmEnabled != null) payload.put("dmEnabled", dmEnabled)
        if (reactionsDisabled != null) payload.put("reactionsDisabled", reactionsDisabled)
        val data = emit(SocketEvent.adminSetPolicies, payload)
        return decodeRoomPolicyMutationResponse(data)
    }

    internal suspend fun getRoomLockStatus(): Boolean {
        val response = getRoomPolicyStatus(SocketEvent.getRoomLockStatus)
        return response.locked ?: throw ErrorException("Room lock status acknowledgement was missing locked state.")
    }

    internal suspend fun getChatLockStatus(): Boolean {
        val response = getRoomPolicyStatus(SocketEvent.getChatLockStatus)
        return response.locked ?: throw ErrorException("Chat lock status acknowledgement was missing locked state.")
    }

    internal suspend fun getDmEnabledStatus(): Boolean {
        val response = getRoomPolicyStatus(SocketEvent.getDmEnabledStatus)
        return response.enabled ?: throw ErrorException("DM status acknowledgement was missing enabled state.")
    }

    internal suspend fun getTtsDisabledStatus(): Boolean {
        val response = getRoomPolicyStatus(SocketEvent.getTtsDisabledStatus)
        return response.disabled ?: throw ErrorException("TTS status acknowledgement was missing disabled state.")
    }

    internal suspend fun getReactionsDisabledStatus(): Boolean {
        val response = getRoomPolicyStatus(SocketEvent.getReactionsDisabledStatus)
        return response.disabled ?: throw ErrorException("Reactions status acknowledgement was missing disabled state.")
    }

    internal suspend fun getMeetingConfig(): MeetingConfigSnapshot {
        val data = emitAckOnly(SocketEvent.meetingGetConfig)
        return JSONDecoder().decode(MeetingConfigSnapshot::class, from = data)
    }

    internal suspend fun updateMeetingConfig(inviteCode: String?): MeetingConfigSnapshot {
        val payload = JSONObject()
        if (inviteCode == null) {
            payload.put("inviteCode", JSONObject.NULL)
        } else {
            payload.put("inviteCode", inviteCode)
        }
        val data = emit(SocketEvent.meetingUpdateConfig, payload)
        val response = JSONDecoder().decode(MeetingConfigUpdateResponse::class, from = data)
        return response.config
    }

    internal suspend fun getWebinarConfig(): WebinarConfigSnapshot {
        val data = emitAckOnly(SocketEvent.webinarGetConfig)
        return JSONDecoder().decode(WebinarConfigSnapshot::class, from = data)
    }

    internal suspend fun updateWebinarEnabled(enabled: Boolean): WebinarConfigSnapshot {
        return updateWebinarConfig(JSONObject().put("enabled", enabled))
    }

    internal suspend fun updateWebinarPublicAccess(publicAccess: Boolean): WebinarConfigSnapshot {
        return updateWebinarConfig(JSONObject().put("publicAccess", publicAccess))
    }

    internal suspend fun updateWebinarLocked(locked: Boolean): WebinarConfigSnapshot {
        return updateWebinarConfig(JSONObject().put("locked", locked))
    }

    internal suspend fun updateWebinarMaxAttendees(maxAttendees: Int): WebinarConfigSnapshot {
        return updateWebinarConfig(JSONObject().put("maxAttendees", maxAttendees))
    }

    internal suspend fun updateWebinarInviteCode(inviteCode: String?): WebinarConfigSnapshot {
        val payload = JSONObject()
        if (inviteCode == null) {
            payload.put("inviteCode", JSONObject.NULL)
        } else {
            payload.put("inviteCode", inviteCode)
        }
        return updateWebinarConfig(payload)
    }

    internal suspend fun updateWebinarLinkSlug(linkSlug: String?): WebinarConfigSnapshot {
        val payload = JSONObject()
        if (linkSlug == null) {
            payload.put("linkSlug", JSONObject.NULL)
        } else {
            payload.put("linkSlug", linkSlug)
        }
        return updateWebinarConfig(payload)
    }

    internal suspend fun generateWebinarLink(): WebinarLinkResponse {
        val data = emitAckOnly(SocketEvent.webinarGenerateLink)
        return JSONDecoder().decode(WebinarLinkResponse::class, from = data)
    }

    internal suspend fun rotateWebinarLink(): WebinarLinkResponse {
        val data = emitAckOnly(SocketEvent.webinarRotateLink)
        return JSONDecoder().decode(WebinarLinkResponse::class, from = data)
    }

    internal suspend fun getBrowserState(): BrowserStateNotification {
        val data = emitAckOnly(SocketEvent.browserGetState)
        return JSONDecoder().decode(BrowserStateNotification::class, from = data)
    }

    internal suspend fun launchBrowser(url: String): LaunchBrowserResponse {
        val request = LaunchBrowserRequest(url = url)
        val data = emit(SocketEvent.browserLaunch, request)
        return JSONDecoder().decode(LaunchBrowserResponse::class, from = data)
    }

    internal suspend fun navigateBrowser(url: String): LaunchBrowserResponse {
        val request = NavigateBrowserRequest(url = url)
        val data = emit(SocketEvent.browserNavigate, request)
        return JSONDecoder().decode(LaunchBrowserResponse::class, from = data)
    }

    internal suspend fun closeBrowser() {
        emitAckOnly(SocketEvent.browserClose)
    }

    internal fun sendBrowserActivity() {
        if (!shouldEmitFireAndForget()) return
        socket?.emit(SocketEvent.browserActivity)
    }

    internal suspend fun getAppsState(): AppsStateNotification {
        val data = emitAckOnly(SocketEvent.appsGetState)
        return JSONDecoder().decode(AppsStateNotification::class, from = data)
    }

    internal suspend fun getGameCatalog(): skip.lib.Array<GameCatalogEntry> {
        val data = emitAckOnly(SocketEvent.gameList)
        return decodeGameCatalog(data)
    }

    internal suspend fun getGameState(): GameStateResponse {
        val data = emitAckOnly(SocketEvent.gameGetState)
        return decodeGameStateResponse(data)
    }

    internal suspend fun startGame(
        gameId: String,
        options: Dictionary<String, GameConfigValue>? = null
    ): GameActionResponse {
        val trimmedGameId = gameId.trim()
        if (trimmedGameId.isEmpty()) {
            throw ErrorException("Invalid game ID")
        }
        val payload = JSONObject().put("gameId", trimmedGameId)
        val optionsObject = gameConfigOptionsObject(options)
        if (optionsObject != null) {
            payload.put("options", optionsObject)
        }
        val data = emit(SocketEvent.gameStart, payload, timeoutMs = START_GAME_ACK_TIMEOUT_MS)
        return decodeGameActionResponse(data)
    }

    internal suspend fun sendGameMove(
        gameId: String,
        type: String,
        payload: GameJSONValue? = null
    ): GameMoveResponse {
        val trimmedGameId = gameId.trim()
        val trimmedType = type.trim()
        if (trimmedGameId.isEmpty() || trimmedType.isEmpty()) {
            throw ErrorException("Invalid game move")
        }
        val request = JSONObject()
            .put("gameId", trimmedGameId)
            .put("type", trimmedType)
        val rawPayload = payload?.rawJSON?.trim()
        if (!rawPayload.isNullOrEmpty() && rawPayload != "null") {
            request.put("payload", jsonValueFromRaw(rawPayload))
        }
        val data = emit(SocketEvent.gameMove, request)
        return decodeGameMoveResponse(data)
    }

    internal suspend fun endGame(): GameActionResponse {
        val data = emitAckOnly(SocketEvent.gameEnd)
        return decodeGameActionResponse(data)
    }

    internal suspend fun openGameVote(candidateIds: skip.lib.Array<String>? = null): GameActionResponse {
        val payload = JSONObject()
        if (candidateIds != null) {
            payload.put("candidates", jsonArray(candidateIds))
        }
        val data = emit(SocketEvent.gameVoteOpen, payload)
        return decodeGameActionResponse(data)
    }

    internal suspend fun castGameVote(gameId: String): GameActionResponse {
        val trimmedGameId = gameId.trim()
        if (trimmedGameId.isEmpty()) {
            throw ErrorException("Invalid game ID")
        }
        val data = emit(SocketEvent.gameVoteCast, JSONObject().put("gameId", trimmedGameId))
        return decodeGameActionResponse(data)
    }

    internal suspend fun cancelGameVote(): GameActionResponse {
        val data = emitAckOnly(SocketEvent.gameVoteCancel)
        return decodeGameActionResponse(data)
    }

    internal suspend fun getTranscriptToken(): TranscriptTokenResponse {
        val data = emitAckOnly(SocketEvent.transcriptGetToken)
        return decodeTranscriptTokenResponse(data)
    }

    internal suspend fun getTranscriptSfuRelayStatus(): TranscriptSfuRelayStatusResponse {
        val data = emitAckOnly(SocketEvent.transcriptSfuRelayStatus)
        return decodeTranscriptSfuRelayStatusResponse(data)
    }

    internal suspend fun startTranscriptSfuRelay(relayStartToken: String): TranscriptSfuRelayStartResponse {
        val trimmedToken = relayStartToken.trim()
        if (trimmedToken.isEmpty()) {
            throw ErrorException("Missing transcript relay start token")
        }
        val data = emit(
            SocketEvent.transcriptSfuRelayStart,
            JSONObject().put("relayStartToken", trimmedToken)
        )
        return decodeTranscriptSfuRelayStartResponse(data)
    }

    internal suspend fun stopTranscriptSfuRelay(): TranscriptSfuRelayStopResponse {
        val data = emitAckOnly(SocketEvent.transcriptSfuRelayStop)
        return decodeTranscriptSfuRelayStopResponse(data)
    }

    internal suspend fun openApp(appId: String): AppsOpenResponse {
        val request = AppsOpenRequest(appId = appId)
        val data = emit(SocketEvent.appsOpen, request)
        return JSONDecoder().decode(AppsOpenResponse::class, from = data)
    }

    internal suspend fun closeApp(): AppsCloseResponse {
        val data = emitAckOnly(SocketEvent.appsClose)
        return JSONDecoder().decode(AppsCloseResponse::class, from = data)
    }

    internal suspend fun setAppsLocked(locked: Boolean): AppsLockResponse {
        val request = AppsLockRequest(locked = locked)
        val data = emit(SocketEvent.appsLock, request)
        return JSONDecoder().decode(AppsLockResponse::class, from = data)
    }

    internal suspend fun syncApp(appId: String, stateVector: Data): AppsSyncResponse {
        val payload = JSONObject()
            .put("appId", appId)
            .put("syncMessage", encodeBase64(stateVector))
        val data = emit(SocketEvent.appsYjsSync, payload)
        val response = decodeAppsSyncResponse(data)
            ?: throw ErrorException("Invalid app sync acknowledgement.")
        return response
    }

    internal fun sendAppYjsUpdate(appId: String, update: Data) {
        if (!shouldEmitFireAndForget()) return
        val trimmedAppId = appId.trim()
        if (trimmedAppId.isEmpty()) return
        val payload = JSONObject()
            .put("appId", trimmedAppId)
            .put("update", encodeBase64(update))
        socket?.emit(SocketEvent.appsYjsUpdate, payload)
    }

    internal fun sendAppAwareness(appId: String, awarenessUpdate: Data, clientId: Int? = null) {
        if (!shouldEmitFireAndForget()) return
        val trimmedAppId = appId.trim()
        if (trimmedAppId.isEmpty()) return
        val payload = JSONObject()
            .put("appId", trimmedAppId)
            .put("awarenessUpdate", encodeBase64(awarenessUpdate))
        if (clientId != null) {
            payload.put("clientId", clientId)
        }
        socket?.emit(SocketEvent.appsAwareness, payload)
    }

    private fun shouldEmitFireAndForget(): Boolean {
        return isConnected && socket != null && !activeRoomId.isNullOrBlank()
    }

    private suspend fun updateWebinarConfig(payload: JSONObject): WebinarConfigSnapshot {
        val data = emit(SocketEvent.webinarUpdateConfig, payload)
        val response = JSONDecoder().decode(WebinarConfigUpdateResponse::class, from = data)
        return response.config
    }

    internal suspend fun admitUser(userId: String) {
        emit(SocketEvent.admitUser, mapOf("userId" to userId))
    }

    internal suspend fun rejectUser(userId: String) {
        emit(SocketEvent.rejectUser, mapOf("userId" to userId))
    }

    internal suspend fun admitAllPending() {
        emitAckOnly(SocketEvent.admitAllPending)
    }

    internal suspend fun rejectAllPending() {
        emitAckOnly(SocketEvent.rejectAllPending)
    }

    internal suspend fun kickUser(userId: String) {
        emit(SocketEvent.kickUser, mapOf("userId" to userId))
    }

    internal suspend fun closeRemoteProducer(producerId: String): CloseRemoteProducerResponse {
        val trimmedProducerId = producerId.trim()
        if (trimmedProducerId.isEmpty()) {
            throw ErrorException("Invalid producer ID")
        }
        val data = emit(SocketEvent.closeRemoteProducer, mapOf("producerId" to trimmedProducerId))
        return decodeCloseRemoteProducerResponse(data)
    }

    internal suspend fun muteUser(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminMuteUser, mapOf("userId" to userId))
        return decodeAdminMediaActionResponse(data)
    }

    internal suspend fun muteUserAudio(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminMuteUserAudio, mapOf("userId" to userId))
        return decodeAdminMediaActionResponse(data)
    }

    internal suspend fun muteAll(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.muteAll)
        return decodeAdminBulkMediaActionResponse(data)
    }

    internal suspend fun closeUserVideo(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminCloseUserVideo, mapOf("userId" to userId))
        return decodeAdminMediaActionResponse(data)
    }

    internal suspend fun closeUserMedia(
        userId: String,
        kinds: skip.lib.Array<String>? = null,
        types: skip.lib.Array<String>? = null,
        reason: String? = null
    ): AdminMediaActionResponse {
        val payload = JSONObject().put("userId", userId)
        if (kinds != null) {
            payload.put("kinds", jsonArray(kinds))
        }
        if (types != null) {
            payload.put("types", jsonArray(types))
        }
        if (reason != null) {
            payload.put("reason", reason)
        }
        val data = emit(SocketEvent.adminCloseUserMedia, payload)
        return decodeAdminMediaActionResponse(data)
    }

    internal suspend fun stopUserScreenShare(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminStopUserScreenShare, mapOf("userId" to userId))
        return decodeAdminMediaActionResponse(data)
    }

    internal suspend fun closeAllVideo(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.closeAllVideo)
        return decodeAdminBulkMediaActionResponse(data)
    }

    internal suspend fun stopAllScreenShares(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.adminStopAllScreenShare)
        return decodeAdminBulkMediaActionResponse(data)
    }

    internal suspend fun clearRaisedHands() {
        emitAckOnly(SocketEvent.adminClearRaisedHands)
    }

    internal suspend fun getAdminRoomState(): AdminRoomSnapshot {
        val data = emitAckOnly(SocketEvent.adminGetRoomState)
        val obj = try {
            JSONObject(dataToString(data))
        } catch (_: Throwable) {
            null
        }
        val room = obj?.optJSONObject("room")?.let { decodeAdminRoomSnapshotObject(it) }
        if (room != null) {
            return room
        }
        return JSONDecoder().decode(AdminRoomStateResponse::class, from = data).room
    }

    internal suspend fun getAdminRoomsDetailed(): skip.lib.Array<AdminRoomSnapshot> {
        val data = emitAckOnly(SocketEvent.adminGetRoomsDetailed)
        return decodeAdminRoomsDetailedResponse(data).rooms
    }

    internal suspend fun getAdminParticipants(): skip.lib.Array<AdminRoomParticipantSnapshot> {
        val data = emitAckOnly(SocketEvent.adminGetParticipants)
        return decodeAdminParticipantsResponse(data).participants
    }

    internal suspend fun getAdminPendingUsers(): skip.lib.Array<PendingUserSnapshot> {
        val data = emitAckOnly(SocketEvent.adminGetPendingUsers)
        return decodeAdminPendingUsersResponse(data).users
    }

    internal suspend fun getAccessLists(): AdminAccessListSnapshot {
        val data = emitAckOnly(SocketEvent.adminGetAccessLists)
        return decodeAdminAccessListsResponse(data)
    }

    internal suspend fun allowUsers(userKeys: skip.lib.Array<String>, allowWhenLocked: Boolean = true): AdminAccessListSnapshot {
        val payload = JSONObject()
            .put("userKeys", jsonArray(userKeys))
            .put("allowWhenLocked", allowWhenLocked)
        val data = emit(SocketEvent.adminAllowUsers, payload)
        return decodeAdminAccessMutation(data)
    }

    internal suspend fun blockUsers(userKeys: skip.lib.Array<String>, kickPresent: Boolean = true, reason: String? = null): AdminAccessListSnapshot {
        val payload = JSONObject()
            .put("userKeys", jsonArray(userKeys))
            .put("kickPresent", kickPresent)
        if (reason == null) {
            payload.put("reason", JSONObject.NULL)
        } else {
            payload.put("reason", reason)
        }
        val data = emit(SocketEvent.adminBlockUsers, payload)
        return decodeAdminAccessMutation(data)
    }

    internal suspend fun unblockUsers(userKeys: skip.lib.Array<String>): AdminAccessListSnapshot {
        val data = emit(SocketEvent.adminUnblockUsers, JSONObject().put("userKeys", jsonArray(userKeys)))
        return decodeAdminAccessMutation(data)
    }

    internal suspend fun revokeAllowedUsers(userKeys: skip.lib.Array<String>, revokeLocked: Boolean = true): AdminAccessListSnapshot {
        val payload = JSONObject()
            .put("userKeys", jsonArray(userKeys))
            .put("revokeLocked", revokeLocked)
        val data = emit(SocketEvent.adminRevokeAllowedUsers, payload)
        return decodeAdminAccessMutation(data)
    }

    internal suspend fun broadcastAdminNotice(message: String, level: AdminNoticeLevel): AdminNoticeResponse {
        val request = AdminNoticeRequest(message = message, level = level.rawValue)
        val data = emit(SocketEvent.adminBroadcastNotice, request)
        return decodeAdminNoticeResponse(data)
    }

    internal suspend fun endRoom(message: String?, delayMs: Int?): AdminEndRoomResponse {
        val request = AdminEndRoomRequest(message = message, delayMs = delayMs)
        val data = emit(SocketEvent.adminEndRoom, request)
        return decodeAdminEndRoomResponse(data)
    }

    internal suspend fun closeRoom(message: String?, delayMs: Int?): AdminEndRoomResponse {
        val request = AdminEndRoomRequest(message = message, delayMs = delayMs)
        val data = emit(SocketEvent.adminCloseRoom, request)
        return decodeAdminEndRoomResponse(data)
    }

    internal suspend fun endRoomNow(message: String?): AdminEndRoomResponse {
        return endRoom(message = message, delayMs = 0)
    }

    internal suspend fun promoteHost(userId: String): PromoteHostResponse {
        val data = emit(SocketEvent.promoteHost, mapOf("userId" to userId))
        return JSONDecoder().decode(PromoteHostResponse::class, from = data)
    }

    internal suspend fun transferHost(userId: String): TransferHostResponse {
        val data = emit(SocketEvent.adminTransferHost, mapOf("userId" to userId))
        return JSONDecoder().decode(TransferHostResponse::class, from = data)
    }

    internal suspend fun redirectUser(userId: String, newRoomId: String): RedirectUserResponse {
        val request = RedirectUserRequest(userId = userId, newRoomId = newRoomId)
        val data = emit(SocketEvent.redirectUser, request)
        return JSONDecoder().decode(RedirectUserResponse::class, from = data)
    }

    private suspend fun getRoomPolicyStatus(event: String): RoomPolicyMutationResponse {
        val data = emitAckOnly(event)
        return decodeRoomPolicyMutationResponse(data)
    }

    private fun decodeAdminAccessMutation(data: Data): AdminAccessListSnapshot {
        val response = decodeAdminAccessMutationResponse(data)
        if (response.success == false) {
            throw ErrorException(response.error ?: "Access list update failed.")
        }
        return response.access ?: throw ErrorException("Access list update did not return access state.")
    }

    private fun jsonArray(values: skip.lib.Array<String>): JSONArray {
        val array = JSONArray()
        values.forEach { value ->
            array.put(value)
        }
        return array
    }

    /// Emit an event whose SFU handler takes ONLY the ack callback (no data
    /// argument). The socket.io Java client treats a trailing Ack as the ack and
    /// sends zero data args, so the server's `(callback) => …` binds correctly.
    private suspend fun emitAckOnly(event: String): Data {
        val socket = socket ?: throw ErrorException("Socket not connected")
        return withAckTimeout(event) {
            suspendCancellableCoroutine { cont ->
                socket.emit(event, object : io.socket.client.Ack {
                    override fun call(vararg args: Any?) {
                        if (!cont.isActive) return
                        if (this@SocketIOManager.socket !== socket) {
                            cont.resumeWithException(ErrorException("Socket changed before $event acknowledgement"))
                            return
                        }
                        val first = args.firstOrNull()
                        val errorMessage = extractError(first)
                        if (errorMessage != null) {
                            cont.resumeWithException(ErrorException(errorMessage))
                            return
                        }
                        val data = jsonData(first) ?: Data()
                        cont.resume(data)
                    }
                })
            }
        }
    }

    private suspend fun emit(event: String, payload: Any, timeoutMs: Long = ACK_TIMEOUT_MS): Data {
        val socket = socket ?: throw ErrorException("Socket not connected")
        val socketPayload = toSocketPayload(payload)

        return withAckTimeout(event, timeoutMs) {
            suspendCancellableCoroutine { cont ->
                socket.emit(event, socketPayload, object : io.socket.client.Ack {
                    override fun call(vararg args: Any?) {
                        if (!cont.isActive) return
                        if (this@SocketIOManager.socket !== socket) {
                            cont.resumeWithException(ErrorException("Socket changed before $event acknowledgement"))
                            return
                        }
                        val first = args.firstOrNull()
                        val errorMessage = extractError(first)
                        if (errorMessage != null) {
                            cont.resumeWithException(ErrorException(errorMessage))
                            return
                        }

                        val data = jsonData(first) ?: Data()
                        cont.resume(data)
                    }
                })
            }
        }
    }

    private suspend fun emitAllowingServerError(event: String, payload: Any): Data {
        val socket = socket ?: throw ErrorException("Socket not connected")
        val socketPayload = toSocketPayload(payload)

        return withAckTimeout(event) {
            suspendCancellableCoroutine { cont ->
                socket.emit(event, socketPayload, object : io.socket.client.Ack {
                    override fun call(vararg args: Any?) {
                        if (!cont.isActive) return
                        if (this@SocketIOManager.socket !== socket) {
                            cont.resumeWithException(ErrorException("Socket changed before $event acknowledgement"))
                            return
                        }

                        val data = jsonData(args.firstOrNull()) ?: Data()
                        cont.resume(data)
                    }
                })
            }
        }
    }

    private fun closeConsumerWithRetry(consumerId: String, attempt: Int, startedAtMs: Long) {
        val socket = socket ?: return
        if (!isConnected || consumerId.isEmpty()) return

        socket.emit(
            SocketEvent.closeConsumer,
            JSONObject().put("consumerId", consumerId),
            object : io.socket.client.Ack {
                override fun call(vararg args: Any?) {
                    if (this@SocketIOManager.socket !== socket) return
                    val errorMessage = extractError(args.firstOrNull()) ?: return
                    if (!shouldRetryCloseConsumer(errorMessage, attempt, startedAtMs)) return

                    closeConsumerHandler.postDelayed(
                        {
                            closeConsumerWithRetry(
                                consumerId = consumerId,
                                attempt = attempt + 1,
                                startedAtMs = startedAtMs
                            )
                        },
                        CLOSE_CONSUMER_RETRY_DELAY_MS
                    )
                }
            }
        )
    }

    private fun shouldRetryCloseConsumer(message: String, attempt: Int, startedAtMs: Long): Boolean {
        if (attempt + 1 >= CLOSE_CONSUMER_MAX_ATTEMPTS) return false
        if (System.currentTimeMillis() - startedAtMs >= CLOSE_CONSUMER_RETRY_WINDOW_MS) return false
        return isCloseConsumerRetryableError(message)
    }

    private fun isCloseConsumerRetryableError(message: String): Boolean {
        val normalized = message.lowercase()
        return normalized.contains("too many consumer control requests") ||
            normalized.contains("retry shortly")
    }

    private suspend fun withAckTimeout(
        event: String,
        timeoutMs: Long = ACK_TIMEOUT_MS,
        block: suspend () -> Data
    ): Data {
        return try {
            withTimeout(timeoutMs) {
                block()
            }
        } catch (_: TimeoutCancellationException) {
            throw ErrorException("Timed out waiting for $event acknowledgement")
        }
    }

    private fun toSocketPayload(payload: Any): Any {
        if (payload is JSONObject || payload is JSONArray || payload is String) {
            return payload
        }

        if (payload is Map<*, *>) {
            val obj = JSONObject()
            payload.forEach { (key, value) ->
                if (key is String) {
                    obj.put(key, value)
                }
            }
            return obj
        }

        val data = JSONEncoder().encode(payload)
        val json = dataToString(data)
        return jsonToAny(json)
    }

    private fun jsonData(value: Any?): Data? {
        val json = when (val compatible = jsonCompatibleValue(value)) {
            JSONObject.NULL -> null
            is JSONObject -> compatible.toString()
            is JSONArray -> compatible.toString()
            is String -> compatible
            else -> compatible.toString()
        } ?: return null

        return Data(platformValue = json.toByteArray(Charsets.UTF_8))
    }

    private fun dataToString(data: Data): String {
        return data.platformValue.toString(Charsets.UTF_8)
    }

    private fun dataObject(data: Data): JSONObject? {
        return try {
            JSONObject(dataToString(data))
        } catch (_: Throwable) {
            null
        }
    }

    private fun encodeBase64(data: Data): String {
        return Base64.getEncoder().encodeToString(data.platformValue)
    }

    private fun jsonObject(value: Any?): JSONObject? {
        return when (value) {
            is JSONObject -> jsonCompatibleObject(value)
            is JSONArray -> value.optJSONObject(0)?.let { jsonCompatibleObject(it) }
            is Map<*, *> -> jsonCompatibleValue(value) as? JSONObject
            is String -> try {
                when (val parsed = jsonToAny(value)) {
                    is JSONObject -> parsed
                    is JSONArray -> parsed.optJSONObject(0)
                    else -> null
                }
            } catch (_: Throwable) {
                null
            }
            else -> null
        }
    }

    private fun jsonCompatibleValue(value: Any?): Any {
        return when (value) {
            null, JSONObject.NULL -> JSONObject.NULL
            is JSONObject -> jsonCompatibleObject(value)
            is JSONArray -> jsonCompatibleArray(value)
            is String -> value
            is Number -> value
            is Boolean -> value
            is ByteArray -> JSONArray().also { array ->
                value.forEach { byte ->
                    array.put(byte.toInt() and 0xff)
                }
            }
            is Map<*, *> -> JSONObject().also { obj ->
                value.forEach { (key, item) ->
                    if (key is String) {
                        obj.put(key, jsonCompatibleValue(item))
                    }
                }
            }
            is Collection<*> -> JSONArray().also { array ->
                value.forEach { item ->
                    array.put(jsonCompatibleValue(item))
                }
            }
            is Array<*> -> JSONArray().also { array ->
                value.forEach { item ->
                    array.put(jsonCompatibleValue(item))
                }
            }
            else -> value.toString()
        }
    }

    private fun jsonCompatibleObject(value: JSONObject): JSONObject {
        val obj = JSONObject()
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            obj.put(key, jsonCompatibleValue(value.opt(key)))
        }
        return obj
    }

    private fun jsonCompatibleArray(value: JSONArray): JSONArray {
        val array = JSONArray()
        for (index in 0 until value.length()) {
            array.put(jsonCompatibleValue(value.opt(index)))
        }
        return array
    }

    private fun rawJsonField(obj: JSONObject, field: String): GameJSONValue? {
        if (!obj.has(field) || obj.isNull(field)) return null
        return GameJSONValue(rawJSON = rawJson(obj.opt(field)))
    }

    private fun rawJson(value: Any?): String {
        return when (val compatible = jsonCompatibleValue(value)) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> compatible.toString()
            is JSONArray -> compatible.toString()
            is String -> JSONObject.quote(compatible)
            is Number -> compatible.toString()
            is Boolean -> compatible.toString()
            else -> JSONObject.quote(compatible.toString())
        }
    }

    private fun jsonValueFromRaw(raw: String): Any {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return JSONObject.NULL
        return try {
            jsonCompatibleValue(JSONArray("[$trimmed]").opt(0))
        } catch (_: Throwable) {
            trimmed
        }
    }

    private fun stringField(obj: JSONObject, field: String): String? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val trimmed = obj.optString(field, "").trim()
        return trimmed.ifEmpty { null }
    }

    private fun displayNameField(obj: JSONObject): String? {
        val fields = arrayOf("displayName", "name", "fullName", "display_name", "username")
        for (field in fields) {
            stringField(obj, field)?.let { return it }
        }
        return null
    }

    private fun boolField(obj: JSONObject, field: String): Boolean? {
        if (!obj.has(field) || obj.isNull(field)) return null
        return when (val value = obj.opt(field)) {
            is Boolean -> value
            is String -> when (value.trim().lowercase()) {
                "true" -> true
                "false" -> false
                else -> null
            }
            else -> null
        }
    }

    private fun changedFlagField(obj: JSONObject, field: String): Boolean? {
        boolField(obj, field)?.let { return it }
        val changed = obj.optJSONObject(field) ?: return null
        return changed.length() > 0
    }

    private fun jsonArrayValue(value: Any?): JSONArray? {
        return when (value) {
            null, JSONObject.NULL -> null
            is JSONArray -> value
            is Collection<*> -> jsonCompatibleValue(value) as? JSONArray
            is Array<*> -> jsonCompatibleValue(value) as? JSONArray
            is String -> try {
                jsonToAny(value) as? JSONArray
            } catch (_: Throwable) {
                null
            }
            else -> null
        }
    }

    private fun jsonArrayField(obj: JSONObject, field: String): JSONArray? {
        return jsonArrayValue(obj.opt(field))
    }

    private fun normalizeJoinRedirectURL(value: String?): String? {
        val trimmed = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return try {
            val uri = java.net.URI(trimmed)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            uri.toString().trimEnd('/')
        } catch (_: Throwable) {
            null
        }
    }

    private fun intField(obj: JSONObject, field: String): Int? {
        if (!obj.has(field) || obj.isNull(field)) return null
        return when (val value = obj.opt(field)) {
            is Number -> value.toInt()
            is String -> value.trim().toIntOrNull()
            else -> null
        }
    }

    private fun doubleField(obj: JSONObject, field: String): Double? {
        if (!obj.has(field) || obj.isNull(field)) return null
        return when (val value = obj.opt(field)) {
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull()
            else -> null
        }
    }

    private fun stringArrayField(obj: JSONObject, field: String): skip.lib.Array<String>? {
        val rawValues = jsonArrayField(obj, field) ?: return null
        val values = mutableListOf<String>()
        for (index in 0 until rawValues.length()) {
            val value = rawValues.opt(index)
            val normalized = when (value) {
                null, JSONObject.NULL -> null
                is String -> value.trim().ifEmpty { null }
                else -> value.toString().trim().ifEmpty { null }
            }
            if (normalized != null) {
                values.add(normalized)
            }
        }
        return skip.lib.Array(values)
    }

    private fun intMapField(obj: JSONObject, field: String): Dictionary<String, Int>? {
        val raw = obj.optJSONObject(field) ?: return null
        var values: Dictionary<String, Int> = dictionaryOf()
        val keys = raw.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = when (val rawValue = raw.opt(key)) {
                is Number -> rawValue.toInt()
                is String -> rawValue.trim().toIntOrNull()
                else -> null
            }
            if (value != null) {
                values[key] = value
            }
        }
        return values
    }

    private fun stringMapField(obj: JSONObject, field: String): Dictionary<String, String>? {
        val raw = obj.optJSONObject(field) ?: return null
        var values: Dictionary<String, String> = dictionaryOf()
        val keys = raw.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = stringField(raw, key) ?: continue
            values[key] = value
        }
        return values
    }

    private fun doubleArrayField(obj: JSONObject, field: String): skip.lib.Array<Double>? {
        val rawValues = jsonArrayField(obj, field) ?: return null
        val values = mutableListOf<Double>()
        for (index in 0 until rawValues.length()) {
            val value = rawValues.opt(index)
            val normalized = when (value) {
                is Number -> value.toDouble()
                is String -> value.trim().toDoubleOrNull()
                else -> null
            }
            if (normalized != null) {
                values.add(normalized)
            }
        }
        return skip.lib.Array(values)
    }

    private fun byteData(value: Any?, allowEmpty: Boolean = false): Data? {
        return when (value) {
            is ByteArray -> if (value.isEmpty() && !allowEmpty) null else Data(platformValue = value)
            is JSONArray -> {
                val bytes = ByteArray(value.length())
                for (i in 0 until value.length()) {
                    val number = value.optInt(i, -1)
                    if (number !in 0..255) return null
                    bytes[i] = number.toByte()
                }
                if (bytes.isEmpty() && !allowEmpty) null else Data(platformValue = bytes)
            }
            is JSONObject -> {
                if (stringField(value, "type") == "Buffer") {
                    byteData(value.opt("data"), allowEmpty)
                } else {
                    null
                }
            }
            is String -> {
                val trimmed = value.trim()
                if (trimmed.isEmpty()) {
                    if (allowEmpty) Data(platformValue = ByteArray(0)) else null
                } else {
                    try {
                        Data(platformValue = Base64.getDecoder().decode(trimmed))
                    } catch (_: Throwable) {
                        null
                    }
                }
            }
            else -> null
        }
    }

    private fun decodeAppsSyncResponse(data: Data): AppsSyncResponse? {
        val obj = try {
            JSONObject(dataToString(data))
        } catch (_: Throwable) {
            return null
        }
        val syncMessage = byteData(obj.opt("syncMessage"), allowEmpty = true) ?: return null
        return AppsSyncResponse(
            syncMessage = syncMessage,
            stateVector = byteData(obj.opt("stateVector"), allowEmpty = true),
            awarenessUpdate = byteData(obj.opt("awarenessUpdate"))
        )
    }

    private fun decodeAppsYjsUpdate(value: Any?): AppsYjsUpdateNotification? {
        val obj = jsonObject(value) ?: return null
        val appId = stringField(obj, "appId") ?: return null
        val update = byteData(obj.opt("update")) ?: return null
        return AppsYjsUpdateNotification(
            appId = appId,
            update = update,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeAppsAwareness(value: Any?): AppsAwarenessNotification? {
        val obj = jsonObject(value) ?: return null
        val appId = stringField(obj, "appId") ?: return null
        val awarenessUpdate = byteData(obj.opt("awarenessUpdate")) ?: return null
        return AppsAwarenessNotification(
            appId = appId,
            awarenessUpdate = awarenessUpdate,
            clientId = intField(obj, "clientId"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeGameCatalog(data: Data): skip.lib.Array<GameCatalogEntry> {
        val raw = try {
            jsonToAny(dataToString(data))
        } catch (_: Throwable) {
            return skip.lib.Array()
        }
        val array = when (raw) {
            is JSONArray -> raw
            is JSONObject -> raw.optJSONArray("games") ?: raw.optJSONArray("catalog") ?: JSONArray()
            else -> JSONArray()
        }
        val entries = mutableListOf<GameCatalogEntry>()
        for (index in 0 until array.length()) {
            val entry = array.optJSONObject(index)?.let { decodeGameCatalogEntryObject(it) } ?: continue
            entries.add(entry)
        }
        return skip.lib.Array(entries)
    }

    private fun decodeGameOptionChoiceObject(obj: JSONObject): GameOptionChoice? {
        return GameOptionChoice(
            value = stringField(obj, "value") ?: return null,
            label = stringField(obj, "label") ?: stringField(obj, "value") ?: return null
        )
    }

    private fun decodeGameOptionSpecObject(obj: JSONObject): GameOptionSpec? {
        val type = stringField(obj, "type") ?: return null
        val choices = mutableListOf<GameOptionChoice>()
        val rawChoices = obj.optJSONArray("choices") ?: JSONArray()
        for (index in 0 until rawChoices.length()) {
            val choice = rawChoices.optJSONObject(index)
                ?.let { decodeGameOptionChoiceObject(it) } ?: continue
            choices.add(choice)
        }
        return GameOptionSpec(
            id = stringField(obj, "id") ?: return null,
            type = type,
            label = stringField(obj, "label") ?: stringField(obj, "id") ?: return null,
            min = doubleField(obj, "min"),
            max = doubleField(obj, "max"),
            defaultNumber = doubleField(obj, "default"),
            defaultString = stringField(obj, "default"),
            presets = doubleArrayField(obj, "presets"),
            suffix = stringField(obj, "suffix"),
            choices = skip.lib.Array(choices),
            placeholder = stringField(obj, "placeholder"),
            maxLength = intField(obj, "maxLength")
        )
    }

    private fun decodeGameCatalogEntryObject(obj: JSONObject): GameCatalogEntry? {
        val rawOptions = obj.optJSONArray("options") ?: JSONArray()
        val options = mutableListOf<GameOptionSpec>()
        for (index in 0 until rawOptions.length()) {
            val option = rawOptions.optJSONObject(index)?.let { decodeGameOptionSpecObject(it) } ?: continue
            options.add(option)
        }
        return GameCatalogEntry(
            id = stringField(obj, "id") ?: return null,
            name = stringField(obj, "name") ?: stringField(obj, "id") ?: return null,
            description = stringField(obj, "description") ?: "",
            minPlayers = intField(obj, "minPlayers") ?: 1,
            maxPlayers = intField(obj, "maxPlayers") ?: 0,
            options = skip.lib.Array(options),
            hasLeaderboard = boolField(obj, "hasLeaderboard") ?: false
        )
    }

    private fun decodeGamePlayerObject(obj: JSONObject): GamePlayer? {
        return GamePlayer(
            id = stringField(obj, "id") ?: return null,
            name = stringField(obj, "name") ?: ""
        )
    }

    private fun decodeGamePublicStateObject(obj: JSONObject): GamePublicState? {
        val rawPlayers = obj.optJSONArray("players") ?: JSONArray()
        val players = mutableListOf<GamePlayer>()
        for (index in 0 until rawPlayers.length()) {
            val player = rawPlayers.optJSONObject(index)?.let { decodeGamePlayerObject(it) } ?: continue
            players.add(player)
        }
        return GamePublicState(
            gameId = stringField(obj, "gameId") ?: return null,
            name = stringField(obj, "name") ?: stringField(obj, "gameId") ?: return null,
            phase = stringField(obj, "phase") ?: "",
            players = skip.lib.Array(players),
            hostId = stringField(obj, "hostId"),
            view = rawJsonField(obj, "view"),
            finished = boolField(obj, "finished") ?: false,
            hasLeaderboard = boolField(obj, "hasLeaderboard") ?: false,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeGamePlayerViewNotificationObject(obj: JSONObject): GamePlayerViewNotification? {
        return GamePlayerViewNotification(
            gameId = stringField(obj, "gameId") ?: return null,
            view = rawJsonField(obj, "view"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeGameVoteStateObject(obj: JSONObject): GameVoteState? {
        val rawCandidates = obj.optJSONArray("candidates") ?: JSONArray()
        val candidates = mutableListOf<GameCatalogEntry>()
        for (index in 0 until rawCandidates.length()) {
            val candidate = rawCandidates.optJSONObject(index)
                ?.let { decodeGameCatalogEntryObject(it) } ?: continue
            candidates.add(candidate)
        }
        return GameVoteState(
            candidates = skip.lib.Array(candidates),
            tally = intMapField(obj, "tally") ?: dictionaryOf(),
            votes = stringMapField(obj, "votes") ?: dictionaryOf(),
            totalPlayers = intField(obj, "totalPlayers") ?: 0,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeGameStateResponse(data: Data): GameStateResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid game state acknowledgement.")
        return GameStateResponse(
            active = boolField(obj, "active") ?: false,
            publicState = obj.optJSONObject("public")?.let { decodeGamePublicStateObject(it) },
            view = rawJsonField(obj, "view"),
            vote = obj.optJSONObject("vote")?.let { decodeGameVoteStateObject(it) }
        )
    }

    private fun decodeGameActionResponse(data: Data): GameActionResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(GameActionResponse::class, from = data)
        }
        return GameActionResponse(
            success = boolField(obj, "success") ?: false,
            gameId = stringField(obj, "gameId"),
            error = stringField(obj, "error")
        )
    }

    private fun decodeGameMoveResponse(data: Data): GameMoveResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(GameMoveResponse::class, from = data)
        }
        return GameMoveResponse(
            success = boolField(obj, "success") ?: false,
            error = stringField(obj, "error")
        )
    }

    private fun decodeGameEnded(value: Any?): GameEndedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<GameEndedNotification>(value)
        }
        return GameEndedNotification(
            gameId = stringField(obj, "gameId"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeTranscriptTokenResponse(data: Data): TranscriptTokenResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid transcript token acknowledgement.")
        val capabilitiesObj = obj.optJSONObject("capabilities") ?: JSONObject()
        return TranscriptTokenResponse(
            roomId = stringField(obj, "roomId") ?: activeRoomId ?: "",
            workerUrl = stringField(obj, "workerUrl")
                ?: throw ErrorException("Invalid transcript token acknowledgement."),
            token = stringField(obj, "token")
                ?: throw ErrorException("Invalid transcript token acknowledgement."),
            expiresAt = doubleField(obj, "expiresAt") ?: 0.0,
            capabilities = TranscriptTokenCapabilities(
                start = boolField(capabilitiesObj, "start") ?: false,
                takeover = boolField(capabilitiesObj, "takeover") ?: false,
                stop = boolField(capabilitiesObj, "stop") ?: false,
                ask = boolField(capabilitiesObj, "ask") ?: false,
                relayAudio = boolField(capabilitiesObj, "relayAudio")
            )
        )
    }

    private fun decodeTranscriptSfuRelayStatusResponse(data: Data): TranscriptSfuRelayStatusResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid transcript relay status acknowledgement.")
        return TranscriptSfuRelayStatusResponse(
            mode = stringField(obj, "mode") ?: "sfu",
            status = stringField(obj, "status") ?: "error",
            available = boolField(obj, "available") ?: false,
            reason = stringField(obj, "reason"),
            updatedAt = doubleField(obj, "updatedAt") ?: 0.0
        )
    }

    private fun decodeTranscriptSfuRelayStartResponse(data: Data): TranscriptSfuRelayStartResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid transcript relay start acknowledgement.")
        return TranscriptSfuRelayStartResponse(
            mode = stringField(obj, "mode") ?: "sfu",
            success = boolField(obj, "success") ?: false,
            status = stringField(obj, "status") ?: "error",
            reason = stringField(obj, "reason"),
            updatedAt = doubleField(obj, "updatedAt") ?: 0.0
        )
    }

    private fun decodeTranscriptSfuRelayStopResponse(data: Data): TranscriptSfuRelayStopResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid transcript relay stop acknowledgement.")
        return TranscriptSfuRelayStopResponse(
            success = boolField(obj, "success") ?: false
        )
    }

    private fun gameConfigOptionsObject(options: Dictionary<String, GameConfigValue>?): JSONObject? {
        if (options == null) return null
        val obj = JSONObject()
        for ((key, value) in options) {
            val trimmedKey = key.trim()
            if (trimmedKey.isEmpty()) continue
            obj.put(trimmedKey, gameConfigPrimitive(value))
        }
        return obj
    }

    private fun gameConfigPrimitive(value: GameConfigValue): Any {
        value.numberValue?.let { return it }
        value.stringValue?.let { return it }
        return ""
    }

    /// Pull a nested JSON object field out of an ack payload as its verbatim
    /// JSON string (used to keep mediasoup capability/parameter blobs raw rather
    /// than re-encoding the decoded Codable struct, which crashes Skip's encoder).
    private fun extractRawObjectField(data: Data, field: String): String? {
        return try {
            val obj = JSONObject(dataToString(data))
            if (obj.has(field)) obj.getJSONObject(field).toString() else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun jsonToAny(json: String): Any {
        val trimmed = json.trim()
        return when {
            trimmed.startsWith("[") -> JSONArray(trimmed)
            trimmed.startsWith("{") -> JSONObject(trimmed)
            else -> trimmed
        }
    }

    private fun extractError(value: Any?): String? {
        if (value is JSONObject) {
            normalizedErrorMessage(value.opt("error"))?.let { return it }
            normalizedErrorMessage(value.opt("message"))?.let { return it }
        }
        if (value is Map<*, *>) {
            normalizedErrorMessage(value["error"])?.let { return it }
            normalizedErrorMessage(value["message"])?.let { return it }
        }
        return normalizedErrorMessage(value)
    }

    private fun socketClientErrorMessage(value: Any?, fallback: String): String {
        return extractError(value) ?: fallback
    }

    private fun normalizedErrorMessage(value: Any?): String? {
        return when (value) {
            null, JSONObject.NULL -> null
            is String -> value.trim().ifEmpty { null }
            is Throwable -> value.localizedMessage?.trim()?.ifEmpty { null }
            else -> null
        }
    }

    private inline fun <reified T : Decodable> decode(value: Any?): T? {
        val data = jsonData(value) ?: return null
        return try {
            JSONDecoder().decode(T::class, from = data)
        } catch (_: Throwable) {
            null
        }
    }

    private fun decodeUserJoined(value: Any?): UserJoinedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<UserJoinedNotification>(value)
        }
        val userId = stringField(obj, "userId") ?: return null
        return UserJoinedNotification(
            userId = userId,
            displayName = displayNameField(obj),
            isGhost = boolField(obj, "isGhost"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeUserLeft(value: Any?): UserLeftNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<UserLeftNotification>(value)
        }
        val userId = stringField(obj, "userId") ?: return null
        return UserLeftNotification(
            userId = userId,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeDisplayNameSnapshot(value: Any?): DisplayNameSnapshotNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<DisplayNameSnapshotNotification>(value)
        }
        val rawUsers = jsonArrayField(obj, "users") ?: return null
        val users = mutableListOf<DisplayNameSnapshotUser>()
        for (index in 0 until rawUsers.length()) {
            val rawUser = rawUsers.optJSONObject(index) ?: continue
            val userId = stringField(rawUser, "userId") ?: continue
            users.add(DisplayNameSnapshotUser(
                userId = userId,
                displayName = displayNameField(rawUser)
            ))
        }
        return DisplayNameSnapshotNotification(
            users = skip.lib.Array(users),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeDisplayNameUpdated(value: Any?): DisplayNameUpdatedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<DisplayNameUpdatedNotification>(value)
        }
        val userId = stringField(obj, "userId") ?: return null
        val displayName = displayNameField(obj) ?: return null
        return DisplayNameUpdatedNotification(
            userId = userId,
            displayName = displayName,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeNewProducer(value: Any?): NewProducerNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<NewProducerNotification>(value)
        }
        return NewProducerNotification(
            producerId = stringField(obj, "producerId") ?: return null,
            producerUserId = stringField(obj, "producerUserId") ?: return null,
            kind = stringField(obj, "kind") ?: return null,
            type = stringField(obj, "type") ?: return null,
            paused = boolField(obj, "paused"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeHandRaised(value: Any?): HandRaisedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<HandRaisedNotification>(value)
        }
        val userId = stringField(obj, "userId") ?: return null
        val raised = boolField(obj, "raised") ?: return null
        return HandRaisedNotification(
            userId = userId,
            raised = raised,
            timestamp = doubleField(obj, "timestamp") ?: 0.0,
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeHandRaisedSnapshot(value: Any?): HandRaisedSnapshotNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<HandRaisedSnapshotNotification>(value)
        }
        val rawUsers = obj.optJSONArray("users") ?: JSONArray()
        val users = mutableListOf<HandRaisedSnapshotUser>()
        for (index in 0 until rawUsers.length()) {
            val rawUser = rawUsers.optJSONObject(index) ?: continue
            val userId = stringField(rawUser, "userId") ?: continue
            val raised = boolField(rawUser, "raised") ?: continue
            users.add(HandRaisedSnapshotUser(userId = userId, raised = raised))
        }
        return HandRaisedSnapshotNotification(
            users = skip.lib.Array(users),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodePendingUsersSnapshot(value: Any?): PendingUsersSnapshotNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<PendingUsersSnapshotNotification>(value)
        }
        val rawUsers = obj.optJSONArray("users") ?: JSONArray()
        val users = mutableListOf<PendingUserSnapshot>()
        for (index in 0 until rawUsers.length()) {
            val rawUser = rawUsers.optJSONObject(index) ?: continue
            val userId = stringField(rawUser, "userId") ?: continue
            users.add(PendingUserSnapshot(
                userId = userId,
                displayName = displayNameField(rawUser)
            ))
        }
        return PendingUsersSnapshotNotification(
            users = skip.lib.Array(users),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeJoinRoomResponse(data: Data): JoinRoomResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid joinRoom acknowledgement.")
        val producers = mutableListOf<ProducerInfo>()
        val rawProducers = jsonArrayField(obj, "existingProducers") ?: JSONArray()
        for (index in 0 until rawProducers.length()) {
            val producer = decodeProducerInfo(rawProducers.opt(index)) ?: continue
            producers.add(producer)
        }
        val displayNameSnapshot = jsonArrayField(obj, "displayNameSnapshot")?.let { rawUsers ->
            val users = mutableListOf<DisplayNameSnapshotUser>()
            for (index in 0 until rawUsers.length()) {
                val rawUser = rawUsers.optJSONObject(index) ?: continue
                val userId = stringField(rawUser, "userId") ?: continue
                users.add(DisplayNameSnapshotUser(
                    userId = userId,
                    displayName = displayNameField(rawUser)
                ))
            }
            skip.lib.Array(users)
        }

        return JoinRoomResponse(
            rtpCapabilities = RtpCapabilities(),
            existingProducers = skip.lib.Array(producers),
            status = stringField(obj, "status"),
            roomId = stringField(obj, "roomId"),
            hostUserId = stringField(obj, "hostUserId"),
            hostUserIds = stringArrayField(obj, "hostUserIds"),
            isLocked = boolField(obj, "isLocked"),
            isChatLocked = boolField(obj, "isChatLocked"),
            noGuests = boolField(obj, "noGuests"),
            isTtsDisabled = boolField(obj, "isTtsDisabled"),
            isDmEnabled = boolField(obj, "isDmEnabled"),
            isReactionsDisabled = boolField(obj, "isReactionsDisabled"),
            meetingRequiresInviteCode = boolField(obj, "meetingRequiresInviteCode"),
            webinarRole = stringField(obj, "webinarRole"),
            isWebinarEnabled = boolField(obj, "isWebinarEnabled"),
            webinarLocked = boolField(obj, "webinarLocked"),
            webinarRequiresInviteCode = boolField(obj, "webinarRequiresInviteCode"),
            webinarAttendeeCount = intField(obj, "webinarAttendeeCount"),
            webinarMaxAttendees = intField(obj, "webinarMaxAttendees"),
            displayNameSnapshot = displayNameSnapshot
        )
    }

    private fun decodeGetProducersResponse(data: Data): GetProducersResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid getProducers acknowledgement.")
        val producers = mutableListOf<ProducerInfo>()
        val rawProducers = jsonArrayField(obj, "producers") ?: JSONArray()
        for (index in 0 until rawProducers.length()) {
            val producer = decodeProducerInfo(rawProducers.opt(index)) ?: continue
            producers.add(producer)
        }
        return GetProducersResponse(producers = skip.lib.Array(producers))
    }

    private fun decodeRoomInfoObject(obj: JSONObject): RoomInfo? {
        val roomId = stringField(obj, "id") ?: return null
        return RoomInfo(
            id = roomId,
            userCount = intField(obj, "userCount") ?: 0
        )
    }

    private fun decodeRoomListResponse(data: Data): RoomListResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid getRooms acknowledgement.")
        val rawRooms = jsonArrayField(obj, "rooms") ?: JSONArray()
        val rooms = mutableListOf<RoomInfo>()
        for (index in 0 until rawRooms.length()) {
            val room = rawRooms.optJSONObject(index)
                ?.let { decodeRoomInfoObject(it) } ?: continue
            rooms.add(room)
        }
        return RoomListResponse(rooms = skip.lib.Array(rooms))
    }

    private fun decodeProducerInfo(value: Any?): ProducerInfo? {
        val obj = jsonObject(value) ?: return decode<ProducerInfo>(value)
        val producerId = stringField(obj, "producerId") ?: return null
        val producerUserId = stringField(obj, "producerUserId") ?: return null
        val kind = stringField(obj, "kind") ?: return null
        val type = stringField(obj, "type") ?: return null
        return ProducerInfo(
            producerId = producerId,
            producerUserId = producerUserId,
            kind = kind,
            type = type,
            paused = boolField(obj, "paused"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeHostAssigned(value: Any?): HostAssignedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<HostAssignedNotification>(value)
        }
        return HostAssignedNotification(
            roomId = stringField(obj, "roomId"),
            hostUserId = stringField(obj, "hostUserId")
        )
    }

    private fun decodeHostChanged(value: Any?): HostChangedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<HostChangedNotification>(value)
        }
        return HostChangedNotification(
            roomId = stringField(obj, "roomId"),
            hostUserId = stringField(obj, "hostUserId")
        )
    }

    private fun decodeAdminUsersChanged(value: Any?): AdminUsersChangedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<AdminUsersChangedNotification>(value)
        }
        return AdminUsersChangedNotification(
            roomId = stringField(obj, "roomId"),
            hostUserIds = stringArrayField(obj, "hostUserIds")
        )
    }

    private fun decodeParticipantConnectionState(value: Any?): ParticipantConnectionStateNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<ParticipantConnectionStateNotification>(value)
        }
        return ParticipantConnectionStateNotification(
            userId = stringField(obj, "userId"),
            roomId = stringField(obj, "roomId"),
            state = stringField(obj, "state"),
            reason = stringField(obj, "reason"),
            graceMs = intField(obj, "graceMs"),
            downtimeMs = intField(obj, "downtimeMs"),
            updatedAt = doubleField(obj, "updatedAt")
        )
    }

    private fun decodeChatMessage(value: Any?): ChatMessageNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<ChatMessageNotification>(value)
        }
        return decodeChatMessageObject(obj)
    }

    private fun decodeChatMessageObject(obj: JSONObject): ChatMessageNotification? {
        return ChatMessageNotification(
            id = stringField(obj, "id") ?: return null,
            userId = stringField(obj, "userId") ?: return null,
            displayName = displayNameField(obj),
            content = stringField(obj, "content") ?: return null,
            timestamp = doubleField(obj, "timestamp") ?: return null,
            gif = obj.optJSONObject("gif")?.let { decodeChatGifAttachmentObject(it) },
            isDirect = boolField(obj, "isDirect"),
            dmTargetUserId = stringField(obj, "dmTargetUserId"),
            dmTargetDisplayName = stringField(obj, "dmTargetDisplayName"),
            roomId = stringField(obj, "roomId"),
            replyTo = obj.optJSONObject("replyTo")?.let { decodeChatReplyPreviewObject(it) }
        )
    }

    private fun decodeChatGifAttachmentObject(obj: JSONObject): ChatGifAttachment? {
        return ChatGifAttachment(
            id = stringField(obj, "id") ?: return null,
            title = stringField(obj, "title") ?: "GIF",
            url = stringField(obj, "url") ?: return null,
            previewUrl = stringField(obj, "previewUrl"),
            pageUrl = stringField(obj, "pageUrl"),
            width = doubleField(obj, "width"),
            height = doubleField(obj, "height"),
            kind = stringField(obj, "kind"),
            videoUrl = stringField(obj, "videoUrl"),
            source = stringField(obj, "source") ?: "klipy"
        )
    }

    private fun decodeChatReplyPreviewObject(obj: JSONObject): ChatReplyPreview? {
        return ChatReplyPreview(
            id = stringField(obj, "id") ?: return null,
            userId = stringField(obj, "userId") ?: return null,
            displayName = displayNameField(obj) ?: "",
            content = stringField(obj, "content") ?: "",
            hasGif = boolField(obj, "hasGif") ?: false,
            isDirect = boolField(obj, "isDirect"),
            dmTargetUserId = stringField(obj, "dmTargetUserId")
        )
    }

    private fun decodeChatHistorySnapshot(value: Any?): ChatHistorySnapshotNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<ChatHistorySnapshotNotification>(value)
        }
        val rawMessages = obj.optJSONArray("messages") ?: JSONArray()
        val messages = mutableListOf<ChatMessageNotification>()
        for (index in 0 until rawMessages.length()) {
            val message = rawMessages.optJSONObject(index)?.let { decodeChatMessageObject(it) } ?: continue
            messages.add(message)
        }
        return ChatHistorySnapshotNotification(
            messages = skip.lib.Array(messages),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeConsumerLayerPreference(value: Any?): ConsumerLayerPreferenceRequest? {
        val obj = jsonObject(value) ?: return null
        val spatialLayer = intField(obj, "spatialLayer") ?: return null
        return ConsumerLayerPreferenceRequest(
            spatialLayer = spatialLayer,
            temporalLayer = intField(obj, "temporalLayer")
        )
    }

    private fun decodeConsumerScoreSnapshot(value: Any?): ConsumerScoreSnapshot? {
        val obj = jsonObject(value) ?: return null
        return ConsumerScoreSnapshot(
            score = doubleField(obj, "score"),
            producerScore = doubleField(obj, "producerScore"),
            producerScores = doubleArrayField(obj, "producerScores")
        )
    }

    private fun decodeConsumerTelemetry(value: Any?): ConsumerTelemetryNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<ConsumerTelemetryNotification>(value)
        }
        return ConsumerTelemetryNotification(
            event = stringField(obj, "event") ?: return null,
            roomId = stringField(obj, "roomId"),
            userId = stringField(obj, "userId"),
            consumerId = stringField(obj, "consumerId") ?: return null,
            producerId = stringField(obj, "producerId") ?: return null,
            kind = stringField(obj, "kind") ?: return null,
            score = decodeConsumerScoreSnapshot(obj.opt("score")),
            paused = boolField(obj, "paused") ?: false,
            producerPaused = boolField(obj, "producerPaused") ?: false,
            priority = intField(obj, "priority") ?: 0,
            preferredLayers = decodeConsumerLayerPreference(obj.opt("preferredLayers")),
            currentLayers = decodeConsumerLayerPreference(obj.opt("currentLayers")),
            timestamp = doubleField(obj, "timestamp")
        )
    }

    private fun decodeProducerInfoObject(obj: JSONObject): ProducerInfo? {
        return ProducerInfo(
            producerId = stringField(obj, "producerId") ?: return null,
            producerUserId = stringField(obj, "producerUserId") ?: return null,
            kind = stringField(obj, "kind") ?: return null,
            type = stringField(obj, "type") ?: return null,
            paused = boolField(obj, "paused"),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun producerInfoArrayField(obj: JSONObject, field: String): skip.lib.Array<ProducerInfo>? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val rawValues = obj.optJSONArray(field) ?: return skip.lib.Array()
        val producers = mutableListOf<ProducerInfo>()
        for (index in 0 until rawValues.length()) {
            val producer = rawValues.optJSONObject(index)?.let { decodeProducerInfoObject(it) } ?: continue
            producers.add(producer)
        }
        return skip.lib.Array(producers)
    }

    private fun decodeAdminMediaProducerObject(obj: JSONObject): AdminMediaProducer? {
        return AdminMediaProducer(
            producerId = stringField(obj, "producerId") ?: return null,
            kind = stringField(obj, "kind") ?: return null,
            type = stringField(obj, "type") ?: return null
        )
    }

    private fun adminMediaProducerArrayField(obj: JSONObject, field: String): skip.lib.Array<AdminMediaProducer>? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val rawValues = obj.optJSONArray(field) ?: return skip.lib.Array()
        val producers = mutableListOf<AdminMediaProducer>()
        for (index in 0 until rawValues.length()) {
            val producer = rawValues.optJSONObject(index)?.let { decodeAdminMediaProducerObject(it) } ?: continue
            producers.add(producer)
        }
        return skip.lib.Array(producers)
    }

    private fun decodeWebinarFeedChanged(value: Any?): WebinarFeedChangedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<WebinarFeedChangedNotification>(value)
        }
        return WebinarFeedChangedNotification(
            roomId = stringField(obj, "roomId"),
            speakerUserId = stringField(obj, "speakerUserId"),
            producers = producerInfoArrayField(obj, "producers")
        )
    }

    private fun decodeWebinarParticipantJoined(value: Any?): WebinarParticipantJoinedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<WebinarParticipantJoinedNotification>(value)
        }
        val userId = stringField(obj, "userId") ?: return null
        return WebinarParticipantJoinedNotification(
            roomId = stringField(obj, "roomId"),
            userId = userId,
            displayName = displayNameField(obj)
        )
    }

    private fun decodeAdminMediaEnforced(value: Any?): AdminMediaEnforcedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<AdminMediaEnforcedNotification>(value)
        }
        return AdminMediaEnforcedNotification(
            roomId = stringField(obj, "roomId"),
            userId = stringField(obj, "userId"),
            producerId = stringField(obj, "producerId"),
            kind = stringField(obj, "kind"),
            type = stringField(obj, "type"),
            action = stringField(obj, "action"),
            reason = stringField(obj, "reason"),
            producers = adminMediaProducerArrayField(obj, "producers")
        )
    }

    private fun decodeAdminBulkMediaEnforced(value: Any?): AdminBulkMediaEnforcedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<AdminBulkMediaEnforcedNotification>(value)
        }
        return AdminBulkMediaEnforcedNotification(
            roomId = stringField(obj, "roomId"),
            reason = stringField(obj, "reason"),
            users = stringArrayField(obj, "users"),
            affectedUsers = intField(obj, "affectedUsers"),
            affectedProducers = intField(obj, "affectedProducers")
        )
    }

    private fun decodeRoomPolicyMutationResponse(data: Data): RoomPolicyMutationResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(RoomPolicyMutationResponse::class, from = data)
        }
        return RoomPolicyMutationResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error"),
            changed = changedFlagField(obj, "changed"),
            locked = boolField(obj, "locked"),
            noGuests = boolField(obj, "noGuests"),
            disabled = boolField(obj, "disabled"),
            enabled = boolField(obj, "enabled"),
            policies = decodeAdminRoomPolicySnapshot(obj.opt("policies"))
        )
    }

    private fun decodeCloseRemoteProducerResponse(data: Data): CloseRemoteProducerResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(CloseRemoteProducerResponse::class, from = data)
        }
        return CloseRemoteProducerResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error"),
            userId = stringField(obj, "userId"),
            kind = stringField(obj, "kind"),
            type = stringField(obj, "type")
        )
    }

    private fun decodeAdminMediaActionResponse(data: Data): AdminMediaActionResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(AdminMediaActionResponse::class, from = data)
        }
        return AdminMediaActionResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error"),
            userId = stringField(obj, "userId"),
            affectedProducers = intField(obj, "affectedProducers"),
            producers = adminMediaProducerArrayField(obj, "producers"),
            closed = boolField(obj, "closed"),
            producerId = stringField(obj, "producerId")
        )
    }

    private fun decodeAdminBulkMediaActionResponse(data: Data): AdminBulkMediaActionResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(AdminBulkMediaActionResponse::class, from = data)
        }
        return AdminBulkMediaActionResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error"),
            count = intField(obj, "count"),
            affectedProducers = intField(obj, "affectedProducers"),
            users = stringArrayField(obj, "users")
        )
    }

    private fun decodeAdminNoticeResponse(data: Data): AdminNoticeResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(AdminNoticeResponse::class, from = data)
        }
        return AdminNoticeResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error")
        )
    }

    private fun decodeAdminEndRoomResponse(data: Data): AdminEndRoomResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(AdminEndRoomResponse::class, from = data)
        }
        return AdminEndRoomResponse(
            success = boolField(obj, "success"),
            roomId = stringField(obj, "roomId"),
            delayMs = intField(obj, "delayMs"),
            error = stringField(obj, "error")
        )
    }

    private fun decodeAdminAccessListsResponse(data: Data): AdminAccessListSnapshot {
        val obj = dataObject(data)
        val access = obj?.opt("access")?.let { decodeAdminAccessListSnapshot(it) }
        if (access != null) {
            return access
        }
        return JSONDecoder().decode(AdminAccessListsResponse::class, from = data).access
    }

    private fun decodeAdminAccessMutationResponse(data: Data): AdminAccessMutationResponse {
        val obj = dataObject(data)
        if (obj == null) {
            return JSONDecoder().decode(AdminAccessMutationResponse::class, from = data)
        }
        return AdminAccessMutationResponse(
            success = boolField(obj, "success"),
            error = stringField(obj, "error"),
            access = decodeAdminAccessListSnapshot(obj.opt("access")),
            allowed = stringArrayField(obj, "allowed"),
            admitted = stringArrayField(obj, "admitted"),
            blocked = stringArrayField(obj, "blocked"),
            unblocked = stringArrayField(obj, "unblocked"),
            revoked = stringArrayField(obj, "revoked"),
            rejectedPending = stringArrayField(obj, "rejectedPending"),
            kickedUserIds = stringArrayField(obj, "kickedUserIds")
        )
    }

    private fun decodeVideoQualityField(obj: JSONObject, field: String): VideoQuality? {
        val rawValue = stringField(obj, field) ?: return null
        return VideoQuality(rawValue = rawValue)
    }

    private fun decodeAdminRoomPolicySnapshot(value: Any?): AdminRoomPolicySnapshot? {
        val obj = jsonObject(value) ?: return null
        return AdminRoomPolicySnapshot(
            locked = boolField(obj, "locked"),
            chatLocked = boolField(obj, "chatLocked"),
            noGuests = boolField(obj, "noGuests"),
            ttsDisabled = boolField(obj, "ttsDisabled"),
            dmEnabled = boolField(obj, "dmEnabled"),
            reactionsDisabled = boolField(obj, "reactionsDisabled"),
            requiresMeetingInviteCode = boolField(obj, "requiresMeetingInviteCode")
        )
    }

    private fun decodeAdminRoomAppsStateSnapshot(value: Any?): AdminRoomAppsStateSnapshot? {
        val obj = jsonObject(value) ?: return null
        return AdminRoomAppsStateSnapshot(
            activeAppId = stringField(obj, "activeAppId"),
            locked = boolField(obj, "locked")
        )
    }

    private fun decodeAdminAccessListSnapshot(value: Any?): AdminAccessListSnapshot? {
        val obj = jsonObject(value) ?: return null
        return AdminAccessListSnapshot(
            allowedUserKeys = stringArrayField(obj, "allowedUserKeys") ?: skip.lib.Array(),
            lockedAllowedUserKeys = stringArrayField(obj, "lockedAllowedUserKeys") ?: skip.lib.Array(),
            blockedUserKeys = stringArrayField(obj, "blockedUserKeys") ?: skip.lib.Array()
        )
    }

    private fun decodeAdminRoomParticipantProducerObject(obj: JSONObject): AdminRoomParticipantProducerSnapshot? {
        return AdminRoomParticipantProducerSnapshot(
            producerId = stringField(obj, "producerId") ?: return null,
            kind = stringField(obj, "kind") ?: return null,
            type = stringField(obj, "type") ?: return null,
            paused = boolField(obj, "paused")
        )
    }

    private fun adminRoomParticipantProducerArrayField(
        obj: JSONObject,
        field: String
    ): skip.lib.Array<AdminRoomParticipantProducerSnapshot>? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val rawValues = obj.optJSONArray(field) ?: return skip.lib.Array()
        val producers = mutableListOf<AdminRoomParticipantProducerSnapshot>()
        for (index in 0 until rawValues.length()) {
            val producer = rawValues.optJSONObject(index)
                ?.let { decodeAdminRoomParticipantProducerObject(it) } ?: continue
            producers.add(producer)
        }
        return skip.lib.Array(producers)
    }

    private fun decodeAdminRoomParticipantObject(obj: JSONObject): AdminRoomParticipantSnapshot? {
        return AdminRoomParticipantSnapshot(
            userId = stringField(obj, "userId") ?: return null,
            userKey = stringField(obj, "userKey"),
            displayName = displayNameField(obj),
            role = stringField(obj, "role"),
            mode = stringField(obj, "mode"),
            muted = boolField(obj, "muted"),
            cameraOff = boolField(obj, "cameraOff"),
            pendingDisconnect = boolField(obj, "pendingDisconnect"),
            producers = adminRoomParticipantProducerArrayField(obj, "producers")
        )
    }

    private fun adminRoomParticipantArrayField(
        obj: JSONObject,
        field: String
    ): skip.lib.Array<AdminRoomParticipantSnapshot>? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val rawValues = obj.optJSONArray(field) ?: return skip.lib.Array()
        val participants = mutableListOf<AdminRoomParticipantSnapshot>()
        for (index in 0 until rawValues.length()) {
            val participant = rawValues.optJSONObject(index)
                ?.let { decodeAdminRoomParticipantObject(it) } ?: continue
            participants.add(participant)
        }
        return skip.lib.Array(participants)
    }

    private fun pendingUserArrayField(obj: JSONObject, field: String): skip.lib.Array<PendingUserSnapshot>? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val rawValues = obj.optJSONArray(field) ?: return skip.lib.Array()
        val users = mutableListOf<PendingUserSnapshot>()
        for (index in 0 until rawValues.length()) {
            val rawUser = rawValues.optJSONObject(index) ?: continue
            val userId = stringField(rawUser, "userId") ?: continue
            users.add(PendingUserSnapshot(
                userId = userId,
                displayName = displayNameField(rawUser)
            ))
        }
        return skip.lib.Array(users)
    }

    private fun decodeAdminRoomSnapshotObject(obj: JSONObject): AdminRoomSnapshot {
        return AdminRoomSnapshot(
            id = stringField(obj, "id"),
            hostUserId = stringField(obj, "hostUserId"),
            adminUserIds = stringArrayField(obj, "adminUserIds"),
            screenShareProducerId = stringField(obj, "screenShareProducerId"),
            quality = decodeVideoQualityField(obj, "quality"),
            policies = decodeAdminRoomPolicySnapshot(obj.opt("policies")),
            access = decodeAdminAccessListSnapshot(obj.opt("access")),
            appsState = decodeAdminRoomAppsStateSnapshot(obj.opt("appsState")),
            participants = adminRoomParticipantArrayField(obj, "participants"),
            pendingUsers = pendingUserArrayField(obj, "pendingUsers")
        )
    }

    private fun decodeAdminRoomsDetailedResponse(data: Data): AdminRoomsDetailedResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid admin room list acknowledgement.")
        val rawRooms = jsonArrayField(obj, "rooms") ?: JSONArray()
        val rooms = mutableListOf<AdminRoomSnapshot>()
        for (index in 0 until rawRooms.length()) {
            val room = rawRooms.optJSONObject(index)
                ?.let { decodeAdminRoomSnapshotObject(it) } ?: continue
            rooms.add(room)
        }
        return AdminRoomsDetailedResponse(rooms = skip.lib.Array(rooms))
    }

    private fun decodeAdminParticipantsResponse(data: Data): AdminParticipantsResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid admin participants acknowledgement.")
        return AdminParticipantsResponse(
            participants = adminRoomParticipantArrayField(obj, "participants") ?: skip.lib.Array(),
            roomId = stringField(obj, "roomId")
        )
    }

    private fun decodeAdminPendingUsersResponse(data: Data): AdminPendingUsersResponse {
        val obj = dataObject(data) ?: throw ErrorException("Invalid admin pending users acknowledgement.")
        return AdminPendingUsersResponse(
            roomId = stringField(obj, "roomId"),
            users = pendingUserArrayField(obj, "users") ?: skip.lib.Array()
        )
    }

    private fun decodeAdminRoomStateChanged(value: Any?): AdminRoomStateChangedNotification? {
        val obj = jsonObject(value)
        if (obj == null) {
            return decode<AdminRoomStateChangedNotification>(value)
        }
        val snapshotObj = obj.optJSONObject("snapshot") ?: return null
        return AdminRoomStateChangedNotification(
            roomId = stringField(obj, "roomId"),
            snapshot = decodeAdminRoomSnapshotObject(snapshotObj)
        )
    }

    private fun normalizedRoomId(roomId: String?): String? {
        val trimmed = roomId?.trim()?.lowercase().orEmpty()
        return trimmed.ifEmpty { null }
    }

    private fun roomAliasSet(requestedRoomId: String?, resolvedRoomId: String?): Set<String> {
        return listOfNotNull(normalizedRoomId(requestedRoomId), normalizedRoomId(resolvedRoomId)).toSet()
    }

    private fun eventRoomIdMatchesActiveOrPending(roomId: String?, allowMissingRoomId: Boolean = false): Boolean {
        val normalized = normalizedRoomId(roomId)
        if (normalized == null) {
            return allowMissingRoomId && (activeRoomAliases.isNotEmpty() || pendingRoomAliases.isNotEmpty())
        }
        if (normalized in activeRoomAliases || normalized in pendingRoomAliases) {
            return true
        }
        return learnPendingResolvedRoomAlias(normalized)
    }

    private fun terminalRoomEventMatchesActiveOrPending(roomId: String?): Boolean {
        return eventRoomIdMatchesActiveOrPending(
            roomId,
            allowMissingRoomId = (activeRoomAliases.isNotEmpty() && pendingRoomAliases.isEmpty()) ||
                (activeRoomAliases.isEmpty() && pendingRoomAliases.isNotEmpty())
        )
    }

    private fun pendingRoomEventMatches(roomId: String?): Boolean {
        if (pendingRoomAliases.isEmpty()) return false
        val normalized = normalizedRoomId(roomId) ?: return true
        if (normalized in pendingRoomAliases) return true
        return learnPendingResolvedRoomAlias(normalized)
    }

    private fun learnPendingResolvedRoomAlias(roomId: String): Boolean {
        if (pendingRoomAliases.isEmpty()) return false
        val learned = pendingResolvedRoomAlias
        if (learned != null) {
            return learned == roomId
        }
        pendingResolvedRoomAlias = roomId
        pendingRoomAliases = pendingRoomAliases + roomId
        return true
    }

    private fun ChatMessageNotification.toChatMessage(taggedRoomId: String? = null): ChatMessage {
        return ChatMessage(
            id = id,
            userId = userId,
            displayName = displayName ?: "",
            content = content,
            timestamp = Date(timeIntervalSince1970 = timestamp / 1000.0),
            gif = gif,
            isDirect = isDirect ?: false,
            dmTargetUserId = dmTargetUserId,
            dmTargetDisplayName = dmTargetDisplayName,
            roomId = roomId ?: taggedRoomId,
            replyTo = replyTo
        )
    }

    private fun registerEventHandlers(socket: Socket) {
        socket.on(SocketEvent.userJoined, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeUserJoined(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserJoined?.invoke(notification)
        })

        socket.on(SocketEvent.userLeft, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeUserLeft(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserLeft?.invoke(notification)
        })

        socket.on(SocketEvent.displayNameSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeDisplayNameSnapshot(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onDisplayNameSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.displayNameUpdated, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeDisplayNameUpdated(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onDisplayNameUpdated?.invoke(notification)
        })

        socket.on(SocketEvent.newProducer, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeNewProducer(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            val roomId = notification.roomId
                ?: activeRoomId
                ?: pendingResolvedRoomAlias
                ?: pendingRoomAliases.firstOrNull()
                ?: return@Listener
            val info = ProducerInfo(
                producerId = notification.producerId,
                producerUserId = notification.producerUserId,
                kind = notification.kind,
                type = notification.type,
                paused = notification.paused,
                roomId = roomId
            )
            onNewProducer?.invoke(info)
        })

        socket.on(SocketEvent.producerClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ProducerClosedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onProducerClosed?.invoke(notification)
        })

        socket.on(SocketEvent.consumerTelemetry, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            if (activeRoomId == null) return@Listener
            val notification = decodeConsumerTelemetry(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onConsumerTelemetry?.invoke(notification)
        })

        socket.on(SocketEvent.adminProducerClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminProducerClosedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onProducerClosed?.invoke(ProducerClosedNotification(
                producerId = notification.producerId,
                producerUserId = notification.userId,
                roomId = notification.roomId,
                adminEnforced = true
            ))
        })

        socket.on(SocketEvent.chatMessage, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeChatMessage(args.firstOrNull()) ?: return@Listener
            val roomId = activeRoomId ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onChatMessage?.invoke(notification.toChatMessage(roomId))
        })

        socket.on(SocketEvent.conclaveMessage, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeChatMessage(args.firstOrNull()) ?: return@Listener
            val roomId = activeRoomId ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onChatMessage?.invoke(notification.toChatMessage(roomId))
        })

        socket.on(SocketEvent.chatHistorySnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeChatHistorySnapshot(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onChatHistorySnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.reaction, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ReactionNotification>( args.firstOrNull()) ?: return@Listener
            val roomId = activeRoomId ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            val modernKind = notification.kind?.let { ReactionKind(rawValue = it) }
            val modernValue = notification.value?.trim()
            val legacyEmoji = notification.emoji?.trim()
            val resolvedKind: ReactionKind
            val resolvedValue: String
            if (modernKind != null && !modernValue.isNullOrEmpty()) {
                resolvedKind = modernKind
                resolvedValue = modernValue
            } else if (!legacyEmoji.isNullOrEmpty()) {
                resolvedKind = ReactionKind.emoji
                resolvedValue = legacyEmoji
            } else {
                return@Listener
            }
            val reaction = Reaction(
                userId = notification.userId,
                kind = resolvedKind,
                value = resolvedValue,
                label = notification.label,
                timestamp = Date(timeIntervalSince1970 = notification.timestamp / 1000.0),
                roomId = notification.roomId ?: roomId
            )
            onReaction?.invoke(reaction)
        })

        socket.on(SocketEvent.handRaised, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeHandRaised(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHandRaised?.invoke(notification)
        })

        socket.on(SocketEvent.handRaisedSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeHandRaisedSnapshot(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHandRaisedSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.roomLockChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RoomLockChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onRoomLockChanged?.invoke(notification)
        })

        socket.on(SocketEvent.chatLockChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ChatLockChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onChatLockChanged?.invoke(notification)
        })

        socket.on(SocketEvent.noGuestsChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<NoGuestsChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onNoGuestsChanged?.invoke(notification)
        })

        socket.on(SocketEvent.dmStateChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<DmStateChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onDmStateChanged?.invoke(notification)
        })

        socket.on(SocketEvent.ttsDisabledChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<TtsDisabledChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onTtsDisabledChanged?.invoke(notification)
        })

        socket.on(SocketEvent.reactionsDisabledChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ReactionsDisabledChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onReactionsDisabledChanged?.invoke(notification)
        })

        socket.on(SocketEvent.userRequestedJoin, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<UserRequestedJoinNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserRequestedJoin?.invoke(notification)
        })

        socket.on(SocketEvent.pendingUsersSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodePendingUsersSnapshot(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onPendingUsersSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.userAdmitted, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.userRejected, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.pendingUserLeft, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.joinApproved, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<JoinDecisionNotification>(args.firstOrNull())
                ?: JoinDecisionNotification(roomId = null)
            if (!pendingRoomEventMatches(notification.roomId)) return@Listener
            onJoinApproved?.invoke(notification)
        })

        socket.on(SocketEvent.joinRejected, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<JoinDecisionNotification>(args.firstOrNull())
                ?: JoinDecisionNotification(roomId = null)
            if (!pendingRoomEventMatches(notification.roomId)) return@Listener
            onJoinRejected?.invoke(notification)
        })

        socket.on(SocketEvent.waitingRoomStatus, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<WaitingRoomStatusNotification>(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWaitingRoomStatus?.invoke(notification)
        })

        socket.on(SocketEvent.hostAssigned, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeHostAssigned(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHostAssigned?.invoke(notification)
        })

        socket.on(SocketEvent.hostChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeHostChanged(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHostChanged?.invoke(notification)
        })

        socket.on(SocketEvent.adminUsersChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAdminUsersChanged(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminUsersChanged?.invoke(notification)
        })

        socket.on(SocketEvent.participantMuted, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ParticipantMutedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onParticipantMuted?.invoke(notification)
        })

        socket.on(SocketEvent.participantCameraOff, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ParticipantCameraOffNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onParticipantCameraOff?.invoke(notification)
        })

        socket.on(SocketEvent.participantConnectionState, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeParticipantConnectionState(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onParticipantConnectionState?.invoke(notification)
        })

        socket.on(SocketEvent.setVideoQuality, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<SetVideoQualityNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onSetVideoQuality?.invoke(notification)
        })

        socket.on(SocketEvent.redirect, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RedirectNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onRedirect?.invoke(notification)
        })

        socket.on(SocketEvent.kicked, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<KickedNotification>(args.firstOrNull())
                ?: KickedNotification(reason = null, roomId = null)
            if (!terminalRoomEventMatchesActiveOrPending(notification.roomId)) return@Listener
            onKicked?.invoke(notification)
        })

        socket.on(SocketEvent.roomClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RoomClosedNotification>(args.firstOrNull())
                ?: RoomClosedNotification(roomId = null, reason = null)
            if (!terminalRoomEventMatchesActiveOrPending(notification.roomId)) return@Listener
            onRoomClosed?.invoke(notification)
        })

        socket.on(SocketEvent.roomEnded, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RoomEndedNotification>(args.firstOrNull())
                ?: RoomEndedNotification(roomId = null, message = null, endedBy = null)
            if (!terminalRoomEventMatchesActiveOrPending(notification.roomId)) return@Listener
            onRoomEnded?.invoke(notification)
        })

        socket.on(SocketEvent.serverRestarting, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ServerRestartingNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onServerRestarting?.invoke(notification)
        })

        socket.on(SocketEvent.adminNotice, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminNoticeNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminNotice?.invoke(notification)
        })

        socket.on(SocketEvent.adminHandsCleared, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminHandsClearedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminHandsCleared?.invoke(notification)
        })

        socket.on(SocketEvent.adminRoomStateChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAdminRoomStateChanged(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId ?: notification.snapshot.id)) return@Listener
            onAdminRoomStateChanged?.invoke(notification)
        })

        socket.on(SocketEvent.meetingConfigChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val snapshot = decode<MeetingConfigSnapshot>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(snapshot.roomId, allowMissingRoomId = true)) return@Listener
            onMeetingConfigChanged?.invoke(snapshot)
        })

        socket.on(SocketEvent.webinarConfigChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val snapshot = decode<WebinarConfigSnapshot>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(snapshot.roomId, allowMissingRoomId = true)) return@Listener
            onWebinarConfigChanged?.invoke(snapshot)
        })

        socket.on(SocketEvent.webinarAttendeeCountChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<WebinarAttendeeCountChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWebinarAttendeeCountChanged?.invoke(notification)
        })

        socket.on(SocketEvent.webinarFeedChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeWebinarFeedChanged(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWebinarFeedChanged?.invoke(notification)
        })

        socket.on(SocketEvent.webinarParticipantJoined, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeWebinarParticipantJoined(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWebinarParticipantJoined?.invoke(notification)
        })

        socket.on(SocketEvent.browserState, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<BrowserStateNotification>(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onBrowserState?.invoke(notification)
        })

        socket.on(SocketEvent.browserClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<BrowserClosedNotification>(args.firstOrNull())
                ?: BrowserClosedNotification(closedBy = null, roomId = null)
            if (!terminalRoomEventMatchesActiveOrPending(notification.roomId)) return@Listener
            onBrowserClosed?.invoke(notification)
        })

        socket.on(SocketEvent.appsState, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AppsStateNotification>(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAppsState?.invoke(notification)
        })

        socket.on(SocketEvent.appsYjsServerUpdate, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAppsYjsUpdate(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onAppsYjsUpdate?.invoke(notification)
        })

        socket.on(SocketEvent.appsServerAwareness, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAppsAwareness(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onAppsAwareness?.invoke(notification)
        })

        socket.on(SocketEvent.gameState, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = jsonObject(args.firstOrNull())
                ?.let { decodeGamePublicStateObject(it) } ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onGameState?.invoke(notification)
        })

        socket.on(SocketEvent.gameView, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = jsonObject(args.firstOrNull())
                ?.let { decodeGamePlayerViewNotificationObject(it) } ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onGameView?.invoke(notification)
        })

        socket.on(SocketEvent.gameSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val data = jsonData(args.firstOrNull()) ?: return@Listener
            val snapshot = try {
                decodeGameStateResponse(data)
            } catch (_: Throwable) {
                return@Listener
            }
            val roomId = snapshot.publicState?.roomId ?: snapshot.vote?.roomId
            if (!eventRoomIdMatchesActiveOrPending(roomId, allowMissingRoomId = true)) return@Listener
            onGameSnapshot?.invoke(snapshot)
        })

        socket.on(SocketEvent.gameEnded, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeGameEnded(args.firstOrNull())
                ?: GameEndedNotification(gameId = null, roomId = null)
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId, allowMissingRoomId = true)) return@Listener
            onGameEnded?.invoke(notification)
        })

        socket.on(SocketEvent.gameVote, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = jsonObject(args.firstOrNull())
                ?.let { decodeGameVoteStateObject(it) }
            val roomId = notification?.roomId
            if (!eventRoomIdMatchesActiveOrPending(roomId, allowMissingRoomId = true)) return@Listener
            onGameVote?.invoke(notification)
        })

        socket.on(SocketEvent.adminMediaEnforced, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAdminMediaEnforced(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminMediaEnforced?.invoke(notification)
        })

        socket.on(SocketEvent.adminBulkMediaEnforced, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAdminBulkMediaEnforced(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminBulkMediaEnforced?.invoke(notification)
        })
    }
}
