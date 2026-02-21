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
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

internal object SocketEvent {
    const val joinRoom = "joinRoom"
    const val createProducerTransport = "createProducerTransport"
    const val createConsumerTransport = "createConsumerTransport"
    const val connectProducerTransport = "connectProducerTransport"
    const val connectConsumerTransport = "connectConsumerTransport"
    const val produce = "produce"
    const val consume = "consume"
    const val resumeConsumer = "resumeConsumer"
    const val toggleMute = "toggleMute"
    const val toggleCamera = "toggleCamera"
    const val closeProducer = "closeProducer"
    const val sendChat = "sendChat"
    const val sendReaction = "sendReaction"
    const val setHandRaised = "setHandRaised"
    const val updateDisplayName = "updateDisplayName"
    const val lockRoom = "lockRoom"
    const val lockChat = "lockChat"
    const val admitUser = "admitUser"
    const val rejectUser = "rejectUser"
    const val kickUser = "kickUser"

    const val userJoined = "userJoined"
    const val userLeft = "userLeft"
    const val displayNameSnapshot = "displayNameSnapshot"
    const val displayNameUpdated = "displayNameUpdated"
    const val newProducer = "newProducer"
    const val producerClosed = "producerClosed"
    const val chatMessage = "chatMessage"
    const val reaction = "reaction"
    const val handRaised = "handRaised"
    const val handRaisedSnapshot = "handRaisedSnapshot"
    const val roomLockChanged = "roomLockChanged"
    const val chatLockChanged = "chatLockChanged"
    const val userRequestedJoin = "userRequestedJoin"
    const val pendingUsersSnapshot = "pendingUsersSnapshot"
    const val userAdmitted = "userAdmitted"
    const val userRejected = "userRejected"
    const val pendingUserLeft = "pendingUserLeft"
    const val joinApproved = "joinApproved"
    const val joinRejected = "joinRejected"
    const val waitingRoomStatus = "waitingRoomStatus"
    const val hostAssigned = "hostAssigned"
    const val participantMuted = "participantMuted"
    const val participantCameraOff = "participantCameraOff"
    const val setVideoQuality = "setVideoQuality"
    const val redirect = "redirect"
    const val kicked = "kicked"
}

internal class SocketIOManager {
    internal var isConnected = false
        private set
    internal var connectionError: Error? = null
        private set

    internal var onConnected: (() -> Unit)? = null
    internal var onDisconnected: ((String?) -> Unit)? = null
    internal var onError: ((Error) -> Unit)? = null
    internal var onReconnecting: ((Int) -> Unit)? = null
    internal var onReconnected: (() -> Unit)? = null
    internal var onReconnectFailed: (() -> Unit)? = null

    internal var onJoinedRoom: ((JoinRoomResponse) -> Unit)? = null
    internal var onWaitingForAdmission: (() -> Unit)? = null
    internal var onWaitingRoomStatus: ((String?) -> Unit)? = null
    internal var onJoinApproved: (() -> Unit)? = null
    internal var onJoinRejected: (() -> Unit)? = null
    internal var onHostAssigned: (() -> Unit)? = null
    internal var onKicked: ((String?) -> Unit)? = null

    internal var onUserJoined: ((UserJoinedNotification) -> Unit)? = null
    internal var onUserLeft: ((String) -> Unit)? = null
    internal var onDisplayNameSnapshot: ((DisplayNameSnapshotNotification) -> Unit)? = null
    internal var onDisplayNameUpdated: ((DisplayNameUpdatedNotification) -> Unit)? = null
    internal var onParticipantMuted: ((ParticipantMutedNotification) -> Unit)? = null
    internal var onParticipantCameraOff: ((ParticipantCameraOffNotification) -> Unit)? = null

    internal var onNewProducer: ((ProducerInfo) -> Unit)? = null
    internal var onProducerClosed: ((ProducerClosedNotification) -> Unit)? = null

    internal var onChatMessage: ((ChatMessage) -> Unit)? = null
    internal var onReaction: ((Reaction) -> Unit)? = null

    internal var onHandRaised: ((String, Boolean) -> Unit)? = null
    internal var onHandRaisedSnapshot: ((HandRaisedSnapshotNotification) -> Unit)? = null

    internal var onRoomLockChanged: ((Boolean) -> Unit)? = null
    internal var onChatLockChanged: ((Boolean) -> Unit)? = null
    internal var onPendingUsersSnapshot: ((PendingUsersSnapshotNotification) -> Unit)? = null
    internal var onUserRequestedJoin: ((UserRequestedJoinNotification) -> Unit)? = null
    internal var onPendingUserChanged: ((PendingUserChangedNotification) -> Unit)? = null
    internal var onRedirect: ((RedirectNotification) -> Unit)? = null
    internal var onSetVideoQuality: ((SetVideoQualityNotification) -> Unit)? = null

    private var manager: Manager? = null
    private var socket: Socket? = null
    private var isIntentionalDisconnect = false
    private var didAttemptReconnect = false

    internal suspend fun connect(sfuURL: String, token: String) {
        if (isConnected) return
        if (token.isBlank()) {
            val error = ErrorException("Missing token for SFU connection")
            connectionError = error
            onError?.invoke(error)
            throw error
        }

        val opts = IO.Options().apply {
            forceNew = true
            reconnection = true
            reconnectionAttempts = 8
            reconnectionDelay = 1000
            reconnectionDelayMax = 5000
            query = "token=${java.net.URLEncoder.encode(token, "UTF-8")}"
            auth = mapOf("token" to token)
        }

        val socket = IO.socket(sfuURL, opts)
        this.socket = socket
        this.manager = socket.io()
        registerEventHandlers(socket)

        suspendCancellableCoroutine<Unit> { cont ->
            var didResume = false

            socket.on(Socket.EVENT_CONNECT, Emitter.Listener {
                isConnected = true
                connectionError = null
                didAttemptReconnect = false
                onConnected?.invoke()
                if (!didResume) {
                    didResume = true
                    cont.resume(Unit)
                }
            })

            socket.on(Socket.EVENT_DISCONNECT, Emitter.Listener { args ->
                isConnected = false
                val reason = args.firstOrNull()?.toString()
                if (!isIntentionalDisconnect) {
                    onDisconnected?.invoke(reason)
                }
            })

            manager?.on(Manager.EVENT_ERROR, Emitter.Listener { args ->
                val error = ErrorException(args.firstOrNull()?.toString() ?: "Socket error")
                connectionError = error
                onError?.invoke(error)
                if (!didResume) {
                    didResume = true
                    cont.resumeWithException(error)
                }
            })

            socket.on(Socket.EVENT_CONNECT_ERROR, Emitter.Listener { args ->
                val error = ErrorException(args.firstOrNull()?.toString() ?: "Connection error")
                connectionError = error
                onError?.invoke(error)
                if (!didResume) {
                    didResume = true
                    cont.resumeWithException(error)
                }
            })

            manager?.on(Manager.EVENT_RECONNECT_ATTEMPT, Emitter.Listener { args ->
                val attempt = (args.firstOrNull() as? Number)?.toInt() ?: 0
                didAttemptReconnect = true
                onReconnecting?.invoke(attempt)
            })

            manager?.on(Manager.EVENT_RECONNECT, Emitter.Listener {
                didAttemptReconnect = false
                onReconnected?.invoke()
            })

            manager?.on(Manager.EVENT_RECONNECT_FAILED, Emitter.Listener {
                if (didAttemptReconnect && !isIntentionalDisconnect) {
                    didAttemptReconnect = false
                    onReconnectFailed?.invoke()
                }
            })

            socket.connect()
        }
    }

    internal fun disconnect() {
        isIntentionalDisconnect = true
        socket?.disconnect()
        socket = null
        manager = null
        isConnected = false
    }

    internal suspend fun joinRoom(
        roomId: String,
        sessionId: String,
        displayName: String?,
        isGhost: Boolean
    ): JoinRoomResponse {
        val request = JoinRoomRequest(
            roomId = roomId,
            sessionId = sessionId,
            displayName = displayName,
            ghost = isGhost
        )

        val data = emit(SocketEvent.joinRoom, request)
        val response = JSONDecoder().decode(JoinRoomResponse::class, from = data)
        if (response.status == "waiting") {
            onWaitingForAdmission?.invoke()
        } else {
            onJoinedRoom?.invoke(response)
        }
        return response
    }

    internal suspend fun createProducerTransport(): TransportResponse {
        val data = emit(SocketEvent.createProducerTransport, mapOf<String, Any?>())
        return JSONDecoder().decode(TransportResponse::class, from = data)
    }

    internal suspend fun createConsumerTransport(): TransportResponse {
        val data = emit(SocketEvent.createConsumerTransport, mapOf<String, Any?>())
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

    internal suspend fun produce(
        transportId: String,
        kind: String,
        rtpParameters: RtpParameters,
        type: ProducerType,
        paused: Boolean
    ): String {
        val request = ProduceRequest(
            transportId = transportId,
            kind = kind,
            rtpParameters = rtpParameters,
            appData = ProducerAppData(type = type.rawValue, paused = paused)
        )
        val data = emit(SocketEvent.produce, request)
        val response = JSONDecoder().decode(ProduceResponse::class, from = data)
        return response.producerId
    }

    internal suspend fun consume(producerId: String, rtpCapabilities: RtpCapabilities): ConsumeResponse {
        val request = ConsumeRequest(producerId = producerId, rtpCapabilities = rtpCapabilities)
        val data = emit(SocketEvent.consume, request)
        return JSONDecoder().decode(ConsumeResponse::class, from = data)
    }

    internal suspend fun resumeConsumer(consumerId: String) {
        val request = ResumeConsumerRequest(consumerId = consumerId)
        emit(SocketEvent.resumeConsumer, request)
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

    internal suspend fun sendChat(content: String) {
        val request = SendChatRequest(content = content)
        emit(SocketEvent.sendChat, request)
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

    internal suspend fun admitUser(userId: String) {
        emit(SocketEvent.admitUser, mapOf("userId" to userId))
    }

    internal suspend fun rejectUser(userId: String) {
        emit(SocketEvent.rejectUser, mapOf("userId" to userId))
    }

    internal suspend fun kickUser(userId: String) {
        emit(SocketEvent.kickUser, mapOf("userId" to userId))
    }

    private suspend fun emit(event: String, payload: Any): Data {
        val socket = socket ?: throw ErrorException("Socket not connected")
        val socketPayload = toSocketPayload(payload)

        return suspendCancellableCoroutine { cont ->
            socket.emit(event, socketPayload, object : io.socket.client.Ack {
                override fun call(vararg args: Any?) {
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

    private fun jsonToAny(json: String): Any {
        val trimmed = json.trim()
        return when {
            trimmed.startsWith("[") -> JSONArray(trimmed)
            trimmed.startsWith("{") -> JSONObject(trimmed)
            else -> trimmed
        }
    }

    private fun extractError(value: Any?): String? {
        if (value is JSONObject && value.has("error")) {
            return value.optString("error", null)
        }
        return null
    }

    private inline fun <reified T : Decodable> decode(value: Any?): T? {
        val data = jsonData(value) ?: return null
        return try {
            JSONDecoder().decode(T::class, from = data)
        } catch (_: Throwable) {
            null
        }
    }

    private fun registerEventHandlers(socket: Socket) {
        socket.on(SocketEvent.userJoined, Emitter.Listener { args ->
            val notification = decode<UserJoinedNotification>( args.firstOrNull()) ?: return@Listener
            onUserJoined?.invoke(notification)
        })

        socket.on(SocketEvent.userLeft, Emitter.Listener { args ->
            val notification = decode<UserLeftNotification>( args.firstOrNull()) ?: return@Listener
            onUserLeft?.invoke(notification.userId)
        })

        socket.on(SocketEvent.displayNameSnapshot, Emitter.Listener { args ->
            val notification = decode<DisplayNameSnapshotNotification>( args.firstOrNull()) ?: return@Listener
            onDisplayNameSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.displayNameUpdated, Emitter.Listener { args ->
            val notification = decode<DisplayNameUpdatedNotification>( args.firstOrNull()) ?: return@Listener
            onDisplayNameUpdated?.invoke(notification)
        })

        socket.on(SocketEvent.newProducer, Emitter.Listener { args ->
            val notification = decode<NewProducerNotification>( args.firstOrNull()) ?: return@Listener
            val info = ProducerInfo(
                producerId = notification.producerId,
                producerUserId = notification.producerUserId,
                kind = notification.kind,
                type = notification.type,
                paused = null
            )
            onNewProducer?.invoke(info)
        })

        socket.on(SocketEvent.producerClosed, Emitter.Listener { args ->
            val notification = decode<ProducerClosedNotification>( args.firstOrNull()) ?: return@Listener
            onProducerClosed?.invoke(notification)
        })

        socket.on(SocketEvent.chatMessage, Emitter.Listener { args ->
            val notification = decode<ChatMessageNotification>( args.firstOrNull()) ?: return@Listener
            val message = ChatMessage(
                id = notification.id,
                userId = notification.userId,
                displayName = notification.displayName,
                content = notification.content,
                timestamp = Date(timeIntervalSince1970 = notification.timestamp / 1000.0)
            )
            onChatMessage?.invoke(message)
        })

        socket.on(SocketEvent.reaction, Emitter.Listener { args ->
            val notification = decode<ReactionNotification>( args.firstOrNull()) ?: return@Listener
            val reaction = Reaction(
                userId = notification.userId,
                kind = ReactionKind(rawValue = notification.kind) ?: ReactionKind.emoji,
                value = notification.value,
                label = notification.label,
                timestamp = Date(timeIntervalSince1970 = notification.timestamp / 1000.0)
            )
            onReaction?.invoke(reaction)
        })

        socket.on(SocketEvent.handRaised, Emitter.Listener { args ->
            val notification = decode<HandRaisedNotification>( args.firstOrNull()) ?: return@Listener
            onHandRaised?.invoke(notification.userId, notification.raised)
        })

        socket.on(SocketEvent.handRaisedSnapshot, Emitter.Listener { args ->
            val notification = decode<HandRaisedSnapshotNotification>( args.firstOrNull()) ?: return@Listener
            onHandRaisedSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.roomLockChanged, Emitter.Listener { args ->
            val notification = decode<RoomLockChangedNotification>( args.firstOrNull()) ?: return@Listener
            onRoomLockChanged?.invoke(notification.locked)
        })

        socket.on(SocketEvent.chatLockChanged, Emitter.Listener { args ->
            val notification = decode<ChatLockChangedNotification>( args.firstOrNull()) ?: return@Listener
            onChatLockChanged?.invoke(notification.locked)
        })

        socket.on(SocketEvent.userRequestedJoin, Emitter.Listener { args ->
            val notification = decode<UserRequestedJoinNotification>( args.firstOrNull()) ?: return@Listener
            onUserRequestedJoin?.invoke(notification)
        })

        socket.on(SocketEvent.pendingUsersSnapshot, Emitter.Listener { args ->
            val notification = decode<PendingUsersSnapshotNotification>( args.firstOrNull()) ?: return@Listener
            onPendingUsersSnapshot?.invoke(notification)
        })

        socket.on(SocketEvent.userAdmitted, Emitter.Listener { args ->
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.userRejected, Emitter.Listener { args ->
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.pendingUserLeft, Emitter.Listener { args ->
            val notification = decode<PendingUserChangedNotification>( args.firstOrNull()) ?: return@Listener
            onPendingUserChanged?.invoke(notification)
        })

        socket.on(SocketEvent.joinApproved, Emitter.Listener {
            onJoinApproved?.invoke()
        })

        socket.on(SocketEvent.joinRejected, Emitter.Listener {
            onJoinRejected?.invoke()
        })

        socket.on(SocketEvent.waitingRoomStatus, Emitter.Listener { args ->
            val notification = decode<WaitingRoomStatusNotification>( args.firstOrNull()) ?: return@Listener
            onWaitingRoomStatus?.invoke(notification.message)
        })

        socket.on(SocketEvent.hostAssigned, Emitter.Listener {
            onHostAssigned?.invoke()
        })

        socket.on(SocketEvent.participantMuted, Emitter.Listener { args ->
            val notification = decode<ParticipantMutedNotification>( args.firstOrNull()) ?: return@Listener
            onParticipantMuted?.invoke(notification)
        })

        socket.on(SocketEvent.participantCameraOff, Emitter.Listener { args ->
            val notification = decode<ParticipantCameraOffNotification>( args.firstOrNull()) ?: return@Listener
            onParticipantCameraOff?.invoke(notification)
        })

        socket.on(SocketEvent.setVideoQuality, Emitter.Listener { args ->
            val notification = decode<SetVideoQualityNotification>( args.firstOrNull()) ?: return@Listener
            onSetVideoQuality?.invoke(notification)
        })

        socket.on(SocketEvent.redirect, Emitter.Listener { args ->
            val notification = decode<RedirectNotification>( args.firstOrNull()) ?: return@Listener
            onRedirect?.invoke(notification)
        })

        socket.on(SocketEvent.kicked, Emitter.Listener {
            onKicked?.invoke(null)
        })
    }
}
