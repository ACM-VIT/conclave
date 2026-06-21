package conclave.module

import io.socket.client.IO
import io.socket.client.Manager
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONArray
import org.json.JSONObject
import skip.foundation.*
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
private const val CONNECT_TIMEOUT_MS = 15_000L
private const val MAX_JOIN_ROOM_REDIRECTS = 1

private class JoinRoomRedirectException(
    message: String,
    val redirectUrl: String
) : RuntimeException(message)

internal object SocketEvent {
    val joinRoom = SfuClientEvent.joinRoom.rawValue
    val createProducerTransport = SfuClientEvent.createProducerTransport.rawValue
    val createConsumerTransport = SfuClientEvent.createConsumerTransport.rawValue
    val connectProducerTransport = SfuClientEvent.connectProducerTransport.rawValue
    val connectConsumerTransport = SfuClientEvent.connectConsumerTransport.rawValue
    val restartIce = SfuClientEvent.restartIce.rawValue
    val produce = SfuClientEvent.produce.rawValue
    val consume = SfuClientEvent.consume.rawValue
    val resumeConsumer = SfuClientEvent.resumeConsumer.rawValue
    val setConsumerPreferences = SfuClientEvent.setConsumerPreferences.rawValue
    val getProducers = SfuClientEvent.getProducers.rawValue
    val toggleMute = SfuClientEvent.toggleMute.rawValue
    val toggleCamera = SfuClientEvent.toggleCamera.rawValue
    val closeProducer = SfuClientEvent.closeProducer.rawValue
    val sendChat = SfuClientEvent.sendChat.rawValue
    val sendReaction = SfuClientEvent.sendReaction.rawValue
    val setHandRaised = SfuClientEvent.setHandRaised.rawValue
    val updateDisplayName = SfuClientEvent.updateDisplayName.rawValue
    val lockRoom = SfuClientEvent.lockRoom.rawValue
    val lockChat = SfuClientEvent.lockChat.rawValue
    val setNoGuests = SfuClientEvent.setNoGuests.rawValue
    val setDmEnabled = SfuClientEvent.setDmEnabled.rawValue
    val setTtsDisabled = SfuClientEvent.setTtsDisabled.rawValue
    val admitUser = SfuClientEvent.admitUser.rawValue
    val rejectUser = SfuClientEvent.rejectUser.rawValue
    val admitAllPending = SfuClientEvent.adminAdmitAllPending.rawValue
    val rejectAllPending = SfuClientEvent.adminRejectAllPending.rawValue
    val kickUser = SfuClientEvent.kickUser.rawValue
    val closeRemoteProducer = SfuClientEvent.closeRemoteProducer.rawValue
    val muteAll = SfuClientEvent.muteAll.rawValue
    val closeAllVideo = SfuClientEvent.closeAllVideo.rawValue
    val promoteHost = SfuClientEvent.promoteHost.rawValue
    val adminMuteUser = SfuClientEvent.adminMuteUser.rawValue
    val adminCloseUserVideo = SfuClientEvent.adminCloseUserVideo.rawValue
    val adminCloseUserMedia = SfuClientEvent.adminCloseUserMedia.rawValue
    val adminStopUserScreenShare = SfuClientEvent.adminStopUserScreenShare.rawValue
    val adminStopAllScreenShare = SfuClientEvent.adminStopAllScreenShare.rawValue
    val adminClearRaisedHands = SfuClientEvent.adminClearRaisedHands.rawValue
    val adminBroadcastNotice = SfuClientEvent.adminBroadcastNotice.rawValue
    val adminGetAccessLists = SfuClientEvent.adminGetAccessLists.rawValue
    val adminAllowUsers = SfuClientEvent.adminAllowUsers.rawValue
    val adminBlockUsers = SfuClientEvent.adminBlockUsers.rawValue
    val adminUnblockUsers = SfuClientEvent.adminUnblockUsers.rawValue
    val adminRevokeAllowedUsers = SfuClientEvent.adminRevokeAllowedUsers.rawValue
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

    val userJoined = SfuServerEvent.userJoined.rawValue
    val userLeft = SfuServerEvent.userLeft.rawValue
    val displayNameSnapshot = SfuServerEvent.displayNameSnapshot.rawValue
    val displayNameUpdated = SfuServerEvent.displayNameUpdated.rawValue
    val newProducer = SfuServerEvent.newProducer.rawValue
    val producerClosed = SfuServerEvent.producerClosed.rawValue
    val chatMessage = SfuServerEvent.chatMessage.rawValue
    val chatHistorySnapshot = SfuServerEvent.chatHistorySnapshot.rawValue
    val reaction = SfuServerEvent.reaction.rawValue
    val handRaised = SfuServerEvent.handRaised.rawValue
    val handRaisedSnapshot = SfuServerEvent.handRaisedSnapshot.rawValue
    val roomLockChanged = SfuServerEvent.roomLockChanged.rawValue
    val chatLockChanged = SfuServerEvent.chatLockChanged.rawValue
    val noGuestsChanged = SfuServerEvent.noGuestsChanged.rawValue
    val dmStateChanged = SfuServerEvent.dmStateChanged.rawValue
    val ttsDisabledChanged = SfuServerEvent.ttsDisabledChanged.rawValue
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
    // SFU emits this today, but the generated event registry does not include it yet.
    val participantConnectionState = "participantConnectionState"
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
    val browserState = SfuServerEvent.browserState.rawValue
    val browserClosed = SfuServerEvent.browserClosed.rawValue
    val appsState = SfuServerEvent.appsState.rawValue
    val appsYjsServerUpdate = SfuServerEvent.appsYjsUpdate.rawValue
    val appsServerAwareness = SfuServerEvent.appsAwareness.rawValue
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
    internal var onJoinApproved: (() -> Unit)? = null
    internal var onJoinRejected: (() -> Unit)? = null
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
    internal var onBrowserState: ((BrowserStateNotification) -> Unit)? = null
    internal var onBrowserClosed: ((BrowserClosedNotification) -> Unit)? = null
    internal var onAppsState: ((AppsStateNotification) -> Unit)? = null
    internal var onAppsYjsUpdate: ((AppsYjsUpdateNotification) -> Unit)? = null
    internal var onAppsAwareness: ((AppsAwarenessNotification) -> Unit)? = null

    internal var onUserJoined: ((UserJoinedNotification) -> Unit)? = null
    internal var onUserLeft: ((UserLeftNotification) -> Unit)? = null
    internal var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Unit)? = null
    internal var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Unit)? = null
    internal var onParticipantMuted: ((ParticipantMutedNotification) -> Unit)? = null
    internal var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Unit)? = null
    internal var onParticipantConnectionState: ((ParticipantConnectionStateNotification) -> Unit)? = null

    internal var onNewProducer: ((ProducerInfo) -> Unit)? = null
    internal var onProducerClosed: ((ProducerClosedNotification) -> Unit)? = null

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
    private var activeAuthToken: String? = null
    private var activeSfuURL: String? = null
    private var pendingConnectFailure: ((ErrorException) -> Unit)? = null

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
        registerEventHandlers(currentSocket)

        try {
            withTimeout(CONNECT_TIMEOUT_MS) {
                suspendCancellableCoroutine<Unit> { cont ->
                    var didResume = false

                    fun cleanupFailedConnect() {
                        pendingConnectFailure = null
                        currentSocket.off()
                        currentManager.off()
                        currentSocket.disconnect()
                        if (socketManager.socket === currentSocket && socketManager.manager === currentManager) {
                            socket = null
                            manager = null
                            isConnected = false
                            activeRoomId = null
                            activeRoomAliases = emptySet()
                            pendingRoomAliases = emptySet()
                            activeAuthToken = null
                            activeSfuURL = null
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
                            pendingConnectFailure = null
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
            connectionError = error
            onError?.invoke(error)
            disconnect()
            throw error
        }
    }

    internal fun disconnect() {
        isIntentionalDisconnect = true
        pendingConnectFailure?.invoke(ErrorException("Socket disconnected before connection completed"))
        pendingConnectFailure = null
        val socketToDisconnect = socket
        socketToDisconnect?.disconnect()
        socketToDisconnect?.off()
        manager?.off()
        socket = null
        manager = null
        activeRoomId = null
        activeRoomAliases = emptySet()
        pendingRoomAliases = emptySet()
        activeAuthToken = null
        activeSfuURL = null
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
        routerRtpCapabilitiesJson = null

        try {
            val data = emitAllowingServerError(SocketEvent.joinRoom, request)
            val errorObject = jsonObject(dataToString(data))
            val errorMessage = errorObject?.let { stringField(it, "error") }
            if (errorMessage != null) {
                pendingRoomAliases = emptySet()
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
            val response = JSONDecoder().decode(JoinRoomResponse::class, from = data)
            val resolvedRoomId = response.roomId ?: requestedRoomId
            if (response.status == "waiting") {
                activeRoomId = null
                activeRoomAliases = emptySet()
                pendingRoomAliases = roomAliasSet(requestedRoomId = requestedRoomId, resolvedRoomId = resolvedRoomId)
            } else {
                activeRoomId = resolvedRoomId
                activeRoomAliases = roomAliasSet(requestedRoomId = requestedRoomId, resolvedRoomId = resolvedRoomId)
                pendingRoomAliases = emptySet()
            }
            return response
        } catch (error: Throwable) {
            pendingRoomAliases = emptySet()
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
        return JSONDecoder().decode(GetProducersResponse::class, from = data)
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

    internal suspend fun sendChat(content: String, recipient: String? = null): ChatMessage {
        val request = SendChatRequest(content = content, recipient = recipient)
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

    internal suspend fun lockRoom(locked: Boolean) {
        emit(SocketEvent.lockRoom, mapOf("locked" to locked))
    }

    internal suspend fun lockChat(locked: Boolean) {
        emit(SocketEvent.lockChat, mapOf("locked" to locked))
    }

    internal suspend fun setNoGuests(noGuests: Boolean) {
        emit(SocketEvent.setNoGuests, mapOf("noGuests" to noGuests))
    }

    internal suspend fun setDmEnabled(enabled: Boolean) {
        emit(SocketEvent.setDmEnabled, mapOf("enabled" to enabled))
    }

    internal suspend fun setTtsDisabled(disabled: Boolean) {
        emit(SocketEvent.setTtsDisabled, mapOf("disabled" to disabled))
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
        socket?.emit(SocketEvent.browserActivity)
    }

    internal suspend fun getAppsState(): AppsStateNotification {
        val data = emitAckOnly(SocketEvent.appsGetState)
        return JSONDecoder().decode(AppsStateNotification::class, from = data)
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
        val payload = JSONObject()
            .put("appId", appId)
            .put("update", encodeBase64(update))
        socket?.emit(SocketEvent.appsYjsUpdate, payload)
    }

    internal fun sendAppAwareness(appId: String, awarenessUpdate: Data, clientId: Int? = null) {
        val payload = JSONObject()
            .put("appId", appId)
            .put("awarenessUpdate", encodeBase64(awarenessUpdate))
        if (clientId != null) {
            payload.put("clientId", clientId)
        }
        socket?.emit(SocketEvent.appsAwareness, payload)
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
        return JSONDecoder().decode(CloseRemoteProducerResponse::class, from = data)
    }

    internal suspend fun muteUser(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminMuteUser, mapOf("userId" to userId))
        return JSONDecoder().decode(AdminMediaActionResponse::class, from = data)
    }

    internal suspend fun muteAll(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.muteAll)
        return JSONDecoder().decode(AdminBulkMediaActionResponse::class, from = data)
    }

    internal suspend fun closeUserVideo(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminCloseUserVideo, mapOf("userId" to userId))
        return JSONDecoder().decode(AdminMediaActionResponse::class, from = data)
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
        return JSONDecoder().decode(AdminMediaActionResponse::class, from = data)
    }

    internal suspend fun stopUserScreenShare(userId: String): AdminMediaActionResponse {
        val data = emit(SocketEvent.adminStopUserScreenShare, mapOf("userId" to userId))
        return JSONDecoder().decode(AdminMediaActionResponse::class, from = data)
    }

    internal suspend fun closeAllVideo(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.closeAllVideo)
        return JSONDecoder().decode(AdminBulkMediaActionResponse::class, from = data)
    }

    internal suspend fun stopAllScreenShares(): AdminBulkMediaActionResponse {
        val data = emitAckOnly(SocketEvent.adminStopAllScreenShare)
        return JSONDecoder().decode(AdminBulkMediaActionResponse::class, from = data)
    }

    internal suspend fun clearRaisedHands() {
        emitAckOnly(SocketEvent.adminClearRaisedHands)
    }

    internal suspend fun getAccessLists(): AdminAccessListSnapshot {
        val data = emitAckOnly(SocketEvent.adminGetAccessLists)
        return JSONDecoder().decode(AdminAccessListsResponse::class, from = data).access
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
        return JSONDecoder().decode(AdminNoticeResponse::class, from = data)
    }

    internal suspend fun endRoom(message: String?, delayMs: Int?): AdminEndRoomResponse {
        val request = AdminEndRoomRequest(message = message, delayMs = delayMs)
        val data = emit(SocketEvent.adminEndRoom, request)
        return JSONDecoder().decode(AdminEndRoomResponse::class, from = data)
    }

    internal suspend fun endRoomNow(message: String?): AdminEndRoomResponse {
        return endRoom(message = message, delayMs = 0)
    }

    internal suspend fun promoteHost(userId: String) {
        emit(SocketEvent.promoteHost, mapOf("userId" to userId))
    }

    private fun decodeAdminAccessMutation(data: Data): AdminAccessListSnapshot {
        val response = JSONDecoder().decode(AdminAccessMutationResponse::class, from = data)
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

    private suspend fun emit(event: String, payload: Any): Data {
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

    private suspend fun withAckTimeout(event: String, block: suspend () -> Data): Data {
        return try {
            withTimeout(ACK_TIMEOUT_MS) {
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
        val json = when (value) {
            null -> null
            is JSONObject -> value.toString()
            is JSONArray -> value.toString()
            is String -> value
            else -> value.toString()
        } ?: return null

        return Data(platformValue = json.toByteArray(Charsets.UTF_8))
    }

    private fun dataToString(data: Data): String {
        return data.platformValue.toString(Charsets.UTF_8)
    }

    private fun encodeBase64(data: Data): String {
        return Base64.getEncoder().encodeToString(data.platformValue)
    }

    private fun jsonObject(value: Any?): JSONObject? {
        return when (value) {
            is JSONObject -> value
            is Map<*, *> -> jsonCompatibleValue(value) as? JSONObject
            is String -> try {
                JSONObject(value)
            } catch (_: Throwable) {
                null
            }
            else -> null
        }
    }

    private fun jsonCompatibleValue(value: Any?): Any {
        return when (value) {
            null -> JSONObject.NULL
            is JSONObject -> value
            is JSONArray -> value
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

    private fun stringField(obj: JSONObject, field: String): String? {
        if (!obj.has(field) || obj.isNull(field)) return null
        val trimmed = obj.optString(field, "").trim()
        return trimmed.ifEmpty { null }
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
            else -> null
        }
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

    private fun normalizedRoomId(roomId: String?): String? {
        val trimmed = roomId?.trim().orEmpty()
        return trimmed.ifEmpty { null }
    }

    private fun roomAliasSet(requestedRoomId: String?, resolvedRoomId: String?): Set<String> {
        return listOfNotNull(normalizedRoomId(requestedRoomId), normalizedRoomId(resolvedRoomId)).toSet()
    }

    private fun eventRoomIdMatchesActiveOrPending(roomId: String?): Boolean {
        val normalized = normalizedRoomId(roomId)
        if (normalized == null) {
            return activeRoomAliases.isNotEmpty() || pendingRoomAliases.isNotEmpty()
        }
        if (normalized in activeRoomAliases || normalized in pendingRoomAliases) {
            return true
        }
        if (pendingRoomAliases.isNotEmpty()) {
            pendingRoomAliases = pendingRoomAliases + normalized
            return true
        }
        return false
    }

    private fun pendingRoomEventMatches(roomId: String?): Boolean {
        if (pendingRoomAliases.isEmpty()) return false
        val normalized = normalizedRoomId(roomId) ?: return true
        if (normalized in pendingRoomAliases) return true
        pendingRoomAliases = pendingRoomAliases + normalized
        return true
    }

    private fun ChatMessageNotification.toChatMessage(taggedRoomId: String? = null): ChatMessage {
        return ChatMessage(
            id = id,
            userId = userId,
            displayName = displayName,
            content = content,
            timestamp = Date(timeIntervalSince1970 = timestamp / 1000.0),
            isDirect = isDirect ?: false,
            dmTargetUserId = dmTargetUserId,
            dmTargetDisplayName = dmTargetDisplayName,
            roomId = roomId ?: taggedRoomId
        )
    }

    private fun registerEventHandlers(socket: Socket) {
        socket.on(SocketEvent.userJoined, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            if (activeRoomId == null) return@Listener
            val notification = decode<UserJoinedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserJoined?.invoke(notification)
        })

        socket.on(SocketEvent.userLeft, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            if (activeRoomId == null) return@Listener
            val notification = decode<UserLeftNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserLeft?.invoke(notification)
        })

        socket.on(SocketEvent.displayNameSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<DisplayNameSnapshotNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onDisplayNameSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.displayNameUpdated, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<DisplayNameUpdatedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onDisplayNameUpdated?.invoke(notification)
        })

        socket.on(SocketEvent.newProducer, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val roomId = activeRoomId ?: return@Listener
            val notification = decode<NewProducerNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            val info = ProducerInfo(
                producerId = notification.producerId,
                producerUserId = notification.producerUserId,
                kind = notification.kind,
                type = notification.type,
                paused = notification.paused,
                roomId = notification.roomId ?: roomId
            )
            onNewProducer?.invoke(info)
        })

        socket.on(SocketEvent.producerClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            if (activeRoomId == null) return@Listener
            val notification = decode<ProducerClosedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onProducerClosed?.invoke(notification)
        })

        socket.on(SocketEvent.adminProducerClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            if (activeRoomId == null) return@Listener
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
            val notification = decode<ChatMessageNotification>( args.firstOrNull()) ?: return@Listener
            val roomId = activeRoomId ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onChatMessage?.invoke(notification.toChatMessage(roomId))
        })

        socket.on(SocketEvent.chatHistorySnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ChatHistorySnapshotNotification>( args.firstOrNull()) ?: return@Listener
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
            if (activeRoomId == null) return@Listener
            val notification = decode<HandRaisedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHandRaised?.invoke(notification)
        })

        socket.on(SocketEvent.handRaisedSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<HandRaisedSnapshotNotification>( args.firstOrNull()) ?: return@Listener
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

        socket.on(SocketEvent.userRequestedJoin, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<UserRequestedJoinNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onUserRequestedJoin?.invoke(notification)
        })

        socket.on(SocketEvent.pendingUsersSnapshot, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<PendingUsersSnapshotNotification>( args.firstOrNull()) ?: return@Listener
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
            if (!pendingRoomEventMatches(notification?.roomId)) return@Listener
            onJoinApproved?.invoke()
        })

        socket.on(SocketEvent.joinRejected, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<JoinDecisionNotification>(args.firstOrNull())
            if (!pendingRoomEventMatches(notification?.roomId)) return@Listener
            onJoinRejected?.invoke()
        })

        socket.on(SocketEvent.waitingRoomStatus, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<WaitingRoomStatusNotification>(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWaitingRoomStatus?.invoke(notification)
        })

        socket.on(SocketEvent.hostAssigned, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<HostAssignedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHostAssigned?.invoke(notification)
        })

        socket.on(SocketEvent.hostChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<HostChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onHostChanged?.invoke(notification)
        })

        socket.on(SocketEvent.adminUsersChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminUsersChangedNotification>( args.firstOrNull()) ?: return@Listener
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
            val notification = decode<ParticipantConnectionStateNotification>(args.firstOrNull()) ?: return@Listener
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
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onKicked?.invoke(notification)
        })

        socket.on(SocketEvent.roomClosed, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RoomClosedNotification>(args.firstOrNull())
                ?: RoomClosedNotification(roomId = null, reason = null)
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onRoomClosed?.invoke(notification)
        })

        socket.on(SocketEvent.roomEnded, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<RoomEndedNotification>(args.firstOrNull())
                ?: RoomEndedNotification(roomId = null, message = null, endedBy = null)
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onRoomEnded?.invoke(notification)
        })

        socket.on(SocketEvent.serverRestarting, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<ServerRestartingNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
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
            val notification = decode<AdminRoomStateChangedNotification>(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId ?: notification.snapshot.id)) return@Listener
            onAdminRoomStateChanged?.invoke(notification)
        })

        socket.on(SocketEvent.meetingConfigChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val snapshot = decode<MeetingConfigSnapshot>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(snapshot.roomId)) return@Listener
            onMeetingConfigChanged?.invoke(snapshot)
        })

        socket.on(SocketEvent.webinarConfigChanged, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val snapshot = decode<WebinarConfigSnapshot>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(snapshot.roomId)) return@Listener
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
            val notification = decode<WebinarFeedChangedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onWebinarFeedChanged?.invoke(notification)
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
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
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
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAppsYjsUpdate?.invoke(notification)
        })

        socket.on(SocketEvent.appsServerAwareness, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decodeAppsAwareness(args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAppsAwareness?.invoke(notification)
        })

        socket.on(SocketEvent.adminMediaEnforced, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminMediaEnforcedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminMediaEnforced?.invoke(notification)
        })

        socket.on(SocketEvent.adminBulkMediaEnforced, Emitter.Listener { args ->
            if (this.socket !== socket) return@Listener
            val notification = decode<AdminBulkMediaEnforcedNotification>( args.firstOrNull()) ?: return@Listener
            if (!eventRoomIdMatchesActiveOrPending(notification.roomId)) return@Listener
            onAdminBulkMediaEnforced?.invoke(notification)
        })
    }
}
