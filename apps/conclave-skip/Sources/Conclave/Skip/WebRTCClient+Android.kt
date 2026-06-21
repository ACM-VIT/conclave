package conclave.module

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.media.projection.MediaProjection
import android.os.Build
import org.mediasoup.droid.Consumer
import org.mediasoup.droid.Device
import org.mediasoup.droid.MediasoupClient
import org.mediasoup.droid.Producer
import org.mediasoup.droid.PeerConnection as MediasoupPeerConnection
import org.mediasoup.droid.RecvTransport
import org.mediasoup.droid.SendTransport
import org.mediasoup.droid.Transport
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import skip.foundation.Data
import skip.foundation.JSONDecoder
import skip.foundation.JSONEncoder
import skip.foundation.ProcessInfo
import skip.lib.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

internal class VideoTrackWrapper(
    override val id: String,
    internal val userId: String,
    internal val isLocal: Boolean,
    track: VideoTrack? = null
) : Identifiable<String> {
    internal var rtcVideoTrack: VideoTrack? = track
    internal var isEnabled: Boolean = track?.enabled() ?: false

    internal fun setTrack(track: VideoTrack?) {
        rtcVideoTrack = track
        isEnabled = track?.enabled() ?: false
    }
}

internal class WebRTCClient : SendTransport.Listener, RecvTransport.Listener, Producer.Listener, Consumer.Listener {
    internal var onLocalAudioEnabledChanged: ((Boolean) -> Unit)? = null
    internal var onLocalVideoEnabledChanged: ((Boolean) -> Unit)? = null
    internal var onTransportConnectionStateChanged: ((String, String) -> Unit)? = null

    internal var localAudioEnabled: Boolean = false
        private set
    internal var localVideoEnabled: Boolean = false
        private set

    internal var remoteVideoTracks: Dictionary<String, VideoTrackWrapper> = dictionaryOf()
        get() = field.sref({ this.remoteVideoTracks = it })
        set(newValue) {
            field = newValue.sref()
        }

    private var localVideoTrackWrapper: VideoTrackWrapper? = null

    private var device: Device? = null
    private var configurationGeneration: Long = 0
    // True once configure() has set up the mediasoup Device and before cleanup()
    // tears it down — lets the rejoin path detect a still-live prior session.
    internal val isConfigured: Boolean get() = device != null
    private var sendTransport: SendTransport? = null
    private var receiveTransport: RecvTransport? = null
    private var sendTransportId: String? = null
    private var receiveTransportId: String? = null
    private var runtimeIceServersJSON: String? = null
    private val transportConnectionStates: MutableMap<String, String> = mutableMapOf()

    private var audioProducer: Producer? = null
    private var videoProducer: Producer? = null
    private var screenProducer: Producer? = null

    private data class ConsumerInfo(
        val consumer: Consumer,
        val producerId: String,
        val userId: String,
        val kind: String,
        val type: String,
        // "{userId}" for webcam, "{userId}-screen" for a screen-share, so a
        // user's webcam + screen tracks coexist (mirrors the iOS client).
        val trackKey: String = "",
    )

    private val consumers: MutableMap<String, ConsumerInfo> = mutableMapOf()
    private val remoteConsumerPreferenceSignatures: MutableMap<String, String> = mutableMapOf()
    private val remoteConsumerLayerPreferenceUnsupportedIds: MutableSet<String> = mutableSetOf()
    private val remoteConsumerPreferenceInFlightIds: MutableSet<String> = mutableSetOf()
    private val remoteConsumerPreferenceScope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private var remoteConsumerPreferenceRetryJob: Job? = null
    private var serverRtpCapabilities: RtpCapabilities? = null

    companion object {
        private const val MAX_REMOTE_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE = 8
        private const val REMOTE_CONSUMER_PREFERENCE_EMIT_SPACING_MS = 75L
        private const val REMOTE_CONSUMER_PREFERENCE_RETRY_DELAY_MS = 1_000L
    }

    private data class RemoteConsumerPreference(
        val spatialLayer: Int?,
        val temporalLayer: Int?,
        val priority: Int,
        val paused: Boolean,
    ) {
        val signature: String
            get() = listOf(
                spatialLayer?.toString() ?: "-",
                temporalLayer?.toString() ?: "-",
                priority.toString(),
                if (paused) "1" else "0",
            ).joinToString(":")

        val hasLayerPreference: Boolean
            get() = spatialLayer != null

        val withoutLayerPreference: RemoteConsumerPreference
            get() = RemoteConsumerPreference(
                spatialLayer = null,
                temporalLayer = null,
                priority = priority,
                paused = paused,
            )
    }

    private data class PendingRemoteConsumerPreferenceUpdate(
        val consumerId: String,
        val effectivePreference: RemoteConsumerPreference,
        val previousSignature: String?,
        val signature: String,
        val urgency: Int,
    )

    private data class InitialConsumerPreference(
        val spatialLayer: Int?,
        val temporalLayer: Int?,
        val priority: Int?,
    )

    private fun initialWebcamConsumerPreference(
        preferHighWebcamLayer: Boolean,
    ): InitialConsumerPreference {
        if (preferHighWebcamLayer) {
            when (currentLocalBandwidthQuality) {
                ConnectionQuality.good -> {
                    return InitialConsumerPreference(
                        spatialLayer = 2,
                        temporalLayer = 2,
                        priority = 180,
                    )
                }
                ConnectionQuality.fair -> {
                    return InitialConsumerPreference(
                        spatialLayer = 1,
                        temporalLayer = 2,
                        priority = 150,
                    )
                }
                ConnectionQuality.poor -> {
                    return InitialConsumerPreference(
                        spatialLayer = 0,
                        temporalLayer = 1,
                        priority = 120,
                    )
                }
                ConnectionQuality.emergency -> {
                    return InitialConsumerPreference(
                        spatialLayer = 0,
                        temporalLayer = 0,
                        priority = 145,
                    )
                }
                ConnectionQuality.unknown -> {
                }
            }
        }

        val temporalLayer = when (currentLocalBandwidthQuality) {
            ConnectionQuality.emergency,
            ConnectionQuality.poor -> 0
            else -> 1
        }

        val priority = when (currentLocalBandwidthQuality) {
            ConnectionQuality.good -> 100
            ConnectionQuality.fair -> 90
            else -> 70
        }

        return InitialConsumerPreference(
            spatialLayer = 0,
            temporalLayer = temporalLayer,
            priority = priority,
        )
    }

    private fun initialScreenConsumerPreference(): InitialConsumerPreference {
        val temporalLayer = when (currentLocalBandwidthQuality) {
            ConnectionQuality.emergency -> 0
            ConnectionQuality.poor -> 1
            else -> 2
        }

        return InitialConsumerPreference(
            spatialLayer = 0,
            temporalLayer = temporalLayer,
            priority = 240,
        )
    }

    private fun initialConsumerPreference(
        producerKind: String?,
        producerType: String,
        preferHighWebcamLayer: Boolean,
    ): InitialConsumerPreference {
        if (producerKind == "audio") {
            return InitialConsumerPreference(
                spatialLayer = null,
                temporalLayer = null,
                priority = 255,
            )
        }

        if (producerKind != "video") {
            return InitialConsumerPreference(
                spatialLayer = null,
                temporalLayer = null,
                priority = null,
            )
        }

        if (producerType == ProducerType.screen.rawValue) {
            return initialScreenConsumerPreference()
        }

        if (producerType != ProducerType.webcam.rawValue) {
            return InitialConsumerPreference(
                spatialLayer = null,
                temporalLayer = null,
                priority = null,
            )
        }

        return initialWebcamConsumerPreference(
            preferHighWebcamLayer = preferHighWebcamLayer,
        )
    }

    private fun isUnsupportedConsumerLayerPreferenceError(error: Throwable): Boolean {
        val message = error.toString().lowercase()
        return message.contains("layer") ||
            message.contains("support") ||
            message.contains("simulcast") ||
            message.contains("svc")
    }

    private fun isConsumerControlRateLimitError(error: Throwable): Boolean {
        val message = error.toString().lowercase()
        return message.contains("too many consumer control requests") ||
            message.contains("retry shortly")
    }

    private fun remoteConsumerPreferenceUrgency(
        info: ConsumerInfo,
        preference: RemoteConsumerPreference,
        focusedUserIds: skip.lib.Set<String>,
        visibleUserIds: skip.lib.Set<String>,
    ): Int {
        if (info.kind == "audio") return 1000
        if (info.type == ProducerType.screen.rawValue) return 990
        if (focusedUserIds.contains(info.userId)) return 850
        if (visibleUserIds.contains(info.userId)) return 750
        if (!preference.paused) return 600
        return 250
    }

    private fun scheduleRemoteConsumerPreferenceRetry(
        focusedUserIds: skip.lib.Set<String>,
        visibleUserIds: skip.lib.Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
    ) {
        if (remoteConsumerPreferenceRetryJob?.isActive == true) return
        remoteConsumerPreferenceRetryJob = remoteConsumerPreferenceScope.launch {
            delay(REMOTE_CONSUMER_PREFERENCE_RETRY_DELAY_MS)
            remoteConsumerPreferenceRetryJob = null
            applyRemoteConsumerBandwidthPolicy(
                focusedUserIds = focusedUserIds,
                visibleUserIds = visibleUserIds,
                connectionQuality = connectionQuality,
                videoQuality = videoQuality,
            )
        }
    }

    internal fun hasBrokenTransport(): Boolean {
        return transportConnectionStates.values.any { state ->
            state == "failed" || state == "disconnected" || state == "closed"
        }
    }

    /// The consumer id we hold for a remote producer (the consumers map is keyed
    /// by consumer id, not producer id). Used by the producer-sync safety net.
    internal fun consumerId(forProducer: String): String? {
        for (entry in consumers) {
            if (entry.value.producerId == forProducer) return entry.key
        }
        return null
    }

    internal fun closeConsumers(exceptProducerIds: skip.lib.Array<String>) {
        val activeProducerIds = exceptProducerIds.toSet()
        val staleConsumers = consumers.filterValues { !activeProducerIds.contains(it.producerId) }
        for ((consumerId, info) in staleConsumers) {
            info.consumer.close()
            consumers.remove(consumerId)
            videoFreezeStats.remove(consumerId)
            remoteConsumerPreferenceSignatures.remove(consumerId)
            remoteConsumerLayerPreferenceUnsupportedIds.remove(consumerId)
            remoteConsumerPreferenceInFlightIds.remove(consumerId)

            val key = if (info.trackKey.isEmpty()) info.userId else info.trackKey
            if (key.isNotEmpty()) {
                remoteVideoTracks.removeValue(forKey = key)
            }
        }
    }

    internal suspend fun applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: skip.lib.Set<String>,
        visibleUserIds: skip.lib.Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
    ) {
        val socket = socketManager ?: return

        val consumerSnapshot = consumers.toList()
        val emergencyKeepWebcamUserId: String? =
            if (connectionQuality == ConnectionQuality.emergency) {
                val webcamInfos = consumerSnapshot
                    .map { it.second }
                    .filter { it.kind == "video" && it.type == ProducerType.webcam.rawValue }
                    .sortedBy { it.userId }
                webcamInfos.firstOrNull { focusedUserIds.contains(it.userId) }?.userId
                    ?: webcamInfos.firstOrNull { visibleUserIds.contains(it.userId) }?.userId
            } else {
                null
            }
        val pendingUpdates = mutableListOf<PendingRemoteConsumerPreferenceUpdate>()
        for ((consumerId, info) in consumerSnapshot) {
            if (!consumers.containsKey(consumerId)) continue
            val preference = remoteConsumerPreference(
                info = info,
                focusedUserIds = focusedUserIds,
                visibleUserIds = visibleUserIds,
                emergencyKeepWebcamUserId = emergencyKeepWebcamUserId,
                connectionQuality = connectionQuality,
                videoQuality = videoQuality,
            ) ?: continue
            if (remoteConsumerPreferenceInFlightIds.contains(consumerId)) continue

            val previousSignature = remoteConsumerPreferenceSignatures[consumerId]
            val effectivePreference =
                if (remoteConsumerLayerPreferenceUnsupportedIds.contains(consumerId)) {
                    preference.withoutLayerPreference
                } else {
                    preference
                }
            val signature = effectivePreference.signature
            if (previousSignature == signature) continue

            pendingUpdates.add(
                PendingRemoteConsumerPreferenceUpdate(
                    consumerId = consumerId,
                    effectivePreference = effectivePreference,
                    previousSignature = previousSignature,
                    signature = signature,
                    urgency = remoteConsumerPreferenceUrgency(
                        info = info,
                        preference = effectivePreference,
                        focusedUserIds = focusedUserIds,
                        visibleUserIds = visibleUserIds,
                    ),
                ),
            )
        }

        val updatesToSend = pendingUpdates
            .sortedWith(
                compareByDescending<PendingRemoteConsumerPreferenceUpdate> { it.urgency }
                    .thenBy { it.consumerId },
            )
            .take(MAX_REMOTE_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE)
        if (pendingUpdates.size > updatesToSend.size) {
            scheduleRemoteConsumerPreferenceRetry(
                focusedUserIds = focusedUserIds,
                visibleUserIds = visibleUserIds,
                connectionQuality = connectionQuality,
                videoQuality = videoQuality,
            )
        }

        for ((index, update) in updatesToSend.withIndex()) {
            if (index > 0) {
                delay(REMOTE_CONSUMER_PREFERENCE_EMIT_SPACING_MS)
            }

            val consumerId = update.consumerId
            if (!consumers.containsKey(consumerId)) continue
            remoteConsumerPreferenceInFlightIds.add(consumerId)
            try {
                socket.setConsumerPreferences(
                    consumerId = consumerId,
                    spatialLayer = update.effectivePreference.spatialLayer,
                    temporalLayer = update.effectivePreference.temporalLayer,
                    priority = update.effectivePreference.priority,
                    paused = update.effectivePreference.paused,
                    requestKeyFrame = update.previousSignature != null && !update.effectivePreference.paused,
                )
                if (consumers.containsKey(consumerId)) {
                    remoteConsumerPreferenceSignatures[consumerId] = update.signature
                }
            } catch (error: Throwable) {
                if (isConsumerControlRateLimitError(error)) {
                    scheduleRemoteConsumerPreferenceRetry(
                        focusedUserIds = focusedUserIds,
                        visibleUserIds = visibleUserIds,
                        connectionQuality = connectionQuality,
                        videoQuality = videoQuality,
                    )
                    continue
                }

                if (update.effectivePreference.hasLayerPreference && isUnsupportedConsumerLayerPreferenceError(error)) {
                    remoteConsumerLayerPreferenceUnsupportedIds.add(consumerId)
                    val fallbackPreference = update.effectivePreference.withoutLayerPreference
                    try {
                        socket.setConsumerPreferences(
                            consumerId = consumerId,
                            spatialLayer = fallbackPreference.spatialLayer,
                            temporalLayer = fallbackPreference.temporalLayer,
                            priority = fallbackPreference.priority,
                            paused = fallbackPreference.paused,
                            requestKeyFrame = update.previousSignature != null && !fallbackPreference.paused,
                        )
                        if (consumers.containsKey(consumerId)) {
                            remoteConsumerPreferenceSignatures[consumerId] = fallbackPreference.signature
                        }
                    } catch (fallbackError: Throwable) {
                        if (isConsumerControlRateLimitError(fallbackError)) {
                            scheduleRemoteConsumerPreferenceRetry(
                                focusedUserIds = focusedUserIds,
                                visibleUserIds = visibleUserIds,
                                connectionQuality = connectionQuality,
                                videoQuality = videoQuality,
                            )
                            continue
                        }
                        debugLog("[WebRTC] Failed to apply fallback consumer bandwidth policy: ${fallbackError}")
                    }
                    continue
                }
                debugLog("[WebRTC] Failed to apply consumer bandwidth policy: ${error}")
            } finally {
                remoteConsumerPreferenceInFlightIds.remove(consumerId)
            }
        }
    }

    private fun remoteConsumerPreference(
        info: ConsumerInfo,
        focusedUserIds: skip.lib.Set<String>,
        visibleUserIds: skip.lib.Set<String>,
        emergencyKeepWebcamUserId: String?,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
    ): RemoteConsumerPreference? {
        if (info.kind == "audio") {
            return RemoteConsumerPreference(
                spatialLayer = null,
                temporalLayer = null,
                priority = 255,
                paused = false,
            )
        }

        if (info.kind != "video") return null

        if (info.type == ProducerType.screen.rawValue) {
            val temporalLayer = when (connectionQuality) {
                ConnectionQuality.emergency -> 0
                ConnectionQuality.poor -> 1
                else -> 2
            }
            return RemoteConsumerPreference(
                spatialLayer = 0,
                temporalLayer = temporalLayer,
                priority = 240,
                paused = false,
            )
        }

        if (info.type != ProducerType.webcam.rawValue) return null

        val isFocused = focusedUserIds.contains(info.userId)
        val isVisible = isFocused || visibleUserIds.contains(info.userId)
        val isEmergency = connectionQuality == ConnectionQuality.emergency
        val emergencyKeepVideo = isEmergency && emergencyKeepWebcamUserId == info.userId
        val isPoor = isEmergency || connectionQuality == ConnectionQuality.poor
        val isFair = connectionQuality == ConnectionQuality.fair
        val isConstrained = isPoor || isFair || videoQuality == VideoQuality.low

        if (isEmergency && !emergencyKeepVideo) {
            return RemoteConsumerPreference(
                spatialLayer = 0,
                temporalLayer = 0,
                priority = 8,
                paused = true,
            )
        }

        if (!isVisible && (isPoor || videoQuality == VideoQuality.low)) {
            return RemoteConsumerPreference(
                spatialLayer = 0,
                temporalLayer = 0,
                priority = 8,
                paused = true,
            )
        }

        if (isFocused) {
            return RemoteConsumerPreference(
                spatialLayer = if (isEmergency) 0 else if (isConstrained) 1 else 2,
                temporalLayer = if (isEmergency) 0 else if (isPoor) 1 else 2,
                priority = if (isEmergency) 145 else if (isConstrained) 150 else 180,
                paused = false,
            )
        }

        if (isVisible) {
            return RemoteConsumerPreference(
                spatialLayer = if (isConstrained) 0 else 1,
                temporalLayer = if (isEmergency) 0 else if (isPoor) 1 else 2,
                priority = if (isEmergency) 70 else if (isConstrained) 80 else 105,
                paused = false,
            )
        }

        return RemoteConsumerPreference(
            spatialLayer = 0,
            temporalLayer = 1,
            priority = 35,
            paused = false,
        )
    }
    private var socketManager: SocketIOManager? = null

    private var peerConnectionFactory: PeerConnectionFactory? = null
    // MUST share the SAME root EGL context as the SurfaceViewRenderer
    // (VideoRendererShared.eglBase). The hardware decoder factory below renders
    // remote frames into textures on this context; if the renderer were inited
    // on a different EglBase.create(), those texture frames can't be drawn and
    // remote video (incl. screen-share) shows black. One shared context across
    // factory (encoder/decoder), capturers, and renderers. Process-global
    // singleton — never released here.
    private val eglBase: EglBase = VideoRendererShared.eglBase
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoCapturer: VideoCapturer? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var currentVideoQuality: VideoQuality = VideoQuality.standard
    private var currentLocalBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var audioProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var videoProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var videoProducerBandwidthSignature: String? = null
    private var screenProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var selectedAudioOutputDeviceId: String? = null
    private var audioBandwidthRefreshInFlight = false
    private var videoBandwidthRefreshInFlight = false
    private var screenBandwidthRefreshInFlight = false
    private var lastAppliedLocalBandwidthSignature: String? = null
    private val screenShareTemporalLayerCount = 3

    private data class WebcamCaptureProfile(
        val width: Int,
        val height: Int,
        val fps: Int,
    )

    private data class WebcamEncodingSpec(
        val rid: String,
        val scaleResolutionDownBy: Double,
        val maxBitrateBps: Int,
        val maxFramerate: Int,
    )

    private data class ScreenShareEncodingCap(
        val maxBitrateBps: Int,
        val maxFramerate: Int,
    )

    // Screen-share capture chain (MediaProjection -> ScreenCapturerAndroid).
    private var screenCapturer: VideoCapturer? = null
    private var screenVideoSource: VideoSource? = null
    private var screenSurfaceTextureHelper: SurfaceTextureHelper? = null
    private var screenVideoTrack: VideoTrack? = null

    internal fun configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) {
        configurationGeneration += 1
        this.socketManager = socketManager
        this.serverRtpCapabilities = rtpCapabilities
        this.runtimeIceServersJSON = iceServersJSON?.trim()?.takeIf { it.isNotEmpty() }

        val context = ProcessInfo.processInfo.androidContext
        MediasoupClient.initialize(context)
        ensurePeerConnectionFactory(context)

        this.device = null
        val device = Device()
        // mediasoup Device.load() takes the router rtpCapabilities as a JSON
        // string. We use the verbatim JSON the server sent in the joinRoom ack
        // (captured by SocketIOManager) rather than re-encoding the decoded
        // Codable struct — Skip's JSONEncoder crashes on the [String: String]
        // codec `parameters` map ("Tuple2 cannot be cast to Encodable"). The
        // raw JSON matches what the iOS path feeds load (numeric `apt`/
        // `packetization-mode`, string `profile-level-id`) — keep it verbatim.
        val capabilities = socketManager.routerRtpCapabilitiesJson
            ?: throw ErrorException("Router RTP capabilities JSON unavailable")
        try {
            device.load(capabilities, null)
            this.device = device
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to load device capabilities: ${error}")
        }
    }

    internal suspend fun createTransports() {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val device = device ?: throw ErrorException("Device not configured")
        val generation = configurationGeneration

        val producerTransportParams = socket.createProducerTransport()
        if (generation != configurationGeneration) {
            throw ErrorException("WebRTC session was replaced")
        }
        val consumerTransportParams = socket.createConsumerTransport()
        if (generation != configurationGeneration) {
            throw ErrorException("WebRTC session was replaced")
        }

        val peerConnectionOptions = resolvePeerConnectionOptions()
        val producerIceParameters = encodeJSONString(producerTransportParams.iceParameters)
        val producerIceCandidates = encodeJSONString(producerTransportParams.iceCandidates)
        val producerDtlsParameters = encodeJSONString(producerTransportParams.dtlsParameters)

        val nextSendTransport = if (peerConnectionOptions != null) {
            device.createSendTransport(
                this,
                producerTransportParams.id,
                producerIceParameters,
                producerIceCandidates,
                producerDtlsParameters,
                null,
                peerConnectionOptions,
                null
            )
        } else {
            device.createSendTransport(
                this,
                producerTransportParams.id,
                producerIceParameters,
                producerIceCandidates,
                producerDtlsParameters
            )
        }

        val consumerIceParameters = encodeJSONString(consumerTransportParams.iceParameters)
        val consumerIceCandidates = encodeJSONString(consumerTransportParams.iceCandidates)
        val consumerDtlsParameters = encodeJSONString(consumerTransportParams.dtlsParameters)

        val nextReceiveTransport = if (peerConnectionOptions != null) {
            device.createRecvTransport(
                this,
                consumerTransportParams.id,
                consumerIceParameters,
                consumerIceCandidates,
                consumerDtlsParameters,
                null,
                peerConnectionOptions,
                null
            )
        } else {
            device.createRecvTransport(
                this,
                consumerTransportParams.id,
                consumerIceParameters,
                consumerIceCandidates,
                consumerDtlsParameters
            )
        }

        if (generation != configurationGeneration) {
            nextSendTransport.close()
            nextReceiveTransport.close()
            throw ErrorException("WebRTC session was replaced")
        }

        sendTransport?.close()
        receiveTransport?.close()
        sendTransportId = producerTransportParams.id
        receiveTransportId = consumerTransportParams.id
        sendTransport = nextSendTransport
        receiveTransport = nextReceiveTransport
    }

    internal suspend fun restartIce(): Boolean {
        val producerReady = sendTransport != null && sendTransportId != null
        val consumerReady = receiveTransport != null && receiveTransportId != null
        if (!producerReady && !consumerReady) return false

        val producerRestarted = if (producerReady) restartIce(transportKind = "producer") else true
        val consumerRestarted = if (consumerReady) restartIce(transportKind = "consumer") else true
        return producerRestarted && consumerRestarted
    }

    internal suspend fun restartIce(transportKind: String): Boolean {
        val socket = socketManager ?: return false
        try {
            when (transportKind) {
                "producer" -> {
                    val transport = sendTransport ?: return false
                    val transportId = sendTransportId ?: return false
                    val response = socket.restartIce(transport = transportKind, transportId = transportId)
                    transport.restartIce(encodeJSONString(response.iceParameters))
                }
                "consumer" -> {
                    val transport = receiveTransport ?: return false
                    val transportId = receiveTransportId ?: return false
                    val response = socket.restartIce(transport = transportKind, transportId = transportId)
                    transport.restartIce(encodeJSONString(response.iceParameters))
                }
                else -> return false
            }
            debugLog("[WebRTC] ${transportKind} transport ICE restart succeeded")
            return true
        } catch (t: Throwable) {
            debugLog("[WebRTC] ${transportKind} transport ICE restart failed: ${t}")
            return false
        }
    }

    internal suspend fun startProducingAudio() {
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        configureCallAudioMode(unmuted = true)
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        if (!ensureRecordAudioPermission()) {
            throw ErrorException("Microphone permission not granted")
        }

        if (audioSource == null) {
            audioSource = peerConnectionFactory?.createAudioSource(microphoneAudioConstraints())
        }

        localAudioTrack = peerConnectionFactory?.createAudioTrack("audio0", audioSource)
        val audioTrack = localAudioTrack ?: throw ErrorException("Audio track unavailable")
        audioTrack.setEnabled(true)

        var pendingProducer: Producer? = null
        try {
            val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
            // produce(listener, track, encodings, codecOptions, codec, appData) — the
            // 5-arg overload's last String is `codec`, NOT appData, so appData must
            // go in the 6-arg slot with codec=null (else it's parsed as a codec).
            val producer = sendTransport.produce(
                this,
                audioTrack as MediaStreamTrack,
                null,
                microphoneOpusCodecOptionsJson(),
                null,
                appData
            )
            pendingProducer = producer
            producer.resume()

            audioProducer = producer
            audioProducerBandwidthQuality = currentLocalBandwidthQuality
            localAudioEnabled = true
            onLocalAudioEnabledChanged?.invoke(true)
        } catch (t: Throwable) {
            pendingProducer?.close()
            localAudioTrack?.setEnabled(false)
            localAudioTrack = null
            clearAudioSource()
            audioProducerBandwidthQuality = ConnectionQuality.unknown
            localAudioEnabled = false
            throw t
        }
    }

    internal suspend fun startProducingVideo() {
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        // Without the CAMERA runtime permission, WebRTC's Camera2Capturer throws a
        // SecurityException on its async capture thread and CRASHES the process
        // (a try/catch around startCapture can't catch that thread). Request the
        // permission before capture starts and bail with a catchable error on denial.
        if (!ensureCameraPermission()) {
            throw ErrorException("Camera permission not granted")
        }

        if (videoCapturer == null) {
            videoCapturer = createCameraCapturer(ProcessInfo.processInfo.androidContext)
        }

        if (surfaceTextureHelper == null) {
            surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
        }

        val capturer = videoCapturer ?: throw ErrorException("No camera capturer")
        var pendingProducer: Producer? = null
        try {
            videoSource = peerConnectionFactory?.createVideoSource(false)
            val source = videoSource ?: throw ErrorException("Video source unavailable")
            capturer.initialize(surfaceTextureHelper, ProcessInfo.processInfo.androidContext, source.capturerObserver)
            val profile = webcamCaptureProfile(currentVideoQuality, currentLocalBandwidthQuality)
            capturer.startCapture(profile.width, profile.height, profile.fps)

            localVideoTrack = peerConnectionFactory?.createVideoTrack("video0", source)
            val videoTrack = localVideoTrack ?: throw ErrorException("Video track unavailable")
            videoTrack.setEnabled(true)

            val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
            val producer = produceWebcamVideo(
                sendTransport,
                videoTrack,
                appData,
                currentLocalBandwidthQuality
            )
            pendingProducer = producer
            producer.resume()
            try {
                producer.setMaxSpatialLayer(
                    webcamMaxSpatialLayer(currentVideoQuality, currentLocalBandwidthQuality)
                )
            } catch (_: Throwable) {
            }

            videoProducer = producer
            videoProducerBandwidthQuality = currentLocalBandwidthQuality
            videoProducerBandwidthSignature = localVideoBandwidthSignature(
                currentVideoQuality,
                currentLocalBandwidthQuality,
            )
            val wrapper = VideoTrackWrapper(id = producer.id, userId = "local", isLocal = true, track = videoTrack)
            localVideoTrackWrapper = wrapper
            localVideoEnabled = true
            onLocalVideoEnabledChanged?.invoke(true)
        } catch (t: Throwable) {
            pendingProducer?.close()
            localVideoTrack?.setEnabled(false)
            localVideoTrack = null
            localVideoTrackWrapper?.setTrack(null)
            localVideoTrackWrapper = null
            try {
                videoCapturer?.stopCapture()
            } catch (_: Throwable) {
            }
            videoCapturer?.dispose()
            videoCapturer = null
            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = null
            clearVideoSource()
            videoProducerBandwidthQuality = ConnectionQuality.unknown
            videoProducerBandwidthSignature = null
            localVideoEnabled = false
            throw t
        }
    }

    /// Mirrors startProducingVideo but captures the device screen via
    /// MediaProjection. The permission result Intent was stored by
    /// ScreenCaptureManager from the consent dialog; ScreenCapturerAndroid mints
    /// its own MediaProjection from it (the foreground service must already be
    /// live with type mediaProjection — the VM awaits requestCapture() first).
    internal suspend fun startScreenSharing() {
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        val context = ProcessInfo.processInfo.androidContext
        ensurePeerConnectionFactory(context)

        // The consent Intent is single-use on API 34+ (one Intent -> one
        // MediaProjection -> one createVirtualDisplay). ScreenCapturerAndroid
        // calls getMediaProjection(RESULT_OK, data) + createVirtualDisplay()
        // synchronously inside startCapture(); both are gated by the OS on the
        // mediaProjection-type FGS already being foregrounded — which the VM
        // guarantees by awaiting ScreenCaptureManager.requestCapture() first.
        val data = ScreenCaptureManager.getCaptureResultIntent()
            ?: throw ErrorException("No screen capture permission")

        // A non-null MediaProjection.Callback is mandatory on API 34+:
        // ScreenCapturerAndroid registers it before createVirtualDisplay(), and
        // omitting it throws IllegalStateException. onStop() fires when the user
        // revokes via the system UI / notification; propagate so the meeting
        // tears down the producer and resets UI.
        val capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() {
                ScreenCaptureManager.onProjectionStoppedExternally()
            }
        })
        screenCapturer = capturer

        screenSurfaceTextureHelper = SurfaceTextureHelper.create("ScreenCaptureThread", eglBase.eglBaseContext)
        screenVideoSource = peerConnectionFactory?.createVideoSource(true)
        val source = screenVideoSource ?: throw ErrorException("Screen source unavailable")
        capturer.initialize(screenSurfaceTextureHelper, context, source.capturerObserver)

        val metrics = context.resources.displayMetrics
        var pendingProducer: Producer? = null
        try {
            val screenCap = screenShareEncodingCap(currentLocalBandwidthQuality)
            // getMediaProjection() + createVirtualDisplay() happen here. If the
            // typed FGS isn't live, or the consent token was already consumed,
            // this throws SecurityException. Tear down the half-built capture
            // chain so a retry starts clean (no leaked SurfaceTextureHelper /
            // capturer) and rethrow for the VM's catch to surface the error.
            capturer.startCapture(
                metrics.widthPixels,
                metrics.heightPixels,
                screenCap.maxFramerate,
            )

            val track = peerConnectionFactory?.createVideoTrack("screen0", source)
                ?: throw ErrorException("Screen track unavailable")
            track.setEnabled(true)
            screenVideoTrack = track

            val appData = encodeJSONString(ProducerAppData(type = ProducerType.screen.rawValue, paused = false))
            val preferredCodec = preferredVideoCodecJson()
            val producer = sendTransport.produce(
                this,
                track as MediaStreamTrack,
                screenShareEncodings(currentLocalBandwidthQuality),
                null,
                preferredCodec,
                appData,
            )
            pendingProducer = producer
            producer.resume()
            screenProducer = producer
            screenProducerBandwidthQuality = currentLocalBandwidthQuality
            debugLog("[WebRTC] Screen sharing producer created: ${producer.id}")
        } catch (t: Throwable) {
            pendingProducer?.close()
            try {
                capturer.stopCapture()
            } catch (_: Throwable) {
            }
            try {
                capturer.dispose()
            } catch (_: Throwable) {
            }
            screenCapturer = null
            screenSurfaceTextureHelper?.dispose()
            screenSurfaceTextureHelper = null
            clearScreenVideoSource()
            screenVideoTrack?.setEnabled(false)
            screenVideoTrack = null
            // Drop the now-consumed/invalid consent token so the next share
            // requests fresh consent instead of reusing a single-use Intent.
            ScreenCaptureManager.stopCapture()
            throw ErrorException("Screen sharing failed to start: ${t}")
        }
    }

    internal suspend fun stopScreenSharing() {
        screenProducer?.close()
        screenProducer = null
        screenProducerBandwidthQuality = ConnectionQuality.unknown
        try {
            screenCapturer?.stopCapture()
        } catch (_: Throwable) {
        }
        screenCapturer?.dispose()
        screenCapturer = null
        screenSurfaceTextureHelper?.dispose()
        screenSurfaceTextureHelper = null
        clearScreenVideoSource()
        screenVideoTrack?.setEnabled(false)
        screenVideoTrack = null
    }

    internal suspend fun consumeProducer(
        producerId: String,
        producerUserId: String,
        producerKind: String? = null,
        producerType: String = "webcam",
        preferHighWebcamLayer: Boolean = false
    ) {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val rtpCapsJson = socket.routerRtpCapabilitiesJson ?: throw ErrorException("RTP caps missing")
        val receiveTransport = receiveTransport ?: throw ErrorException("Receive transport missing")
        val receiveTransportId = receiveTransportId ?: throw ErrorException("Receive transport ID missing")

        // Raw-JSON path: send the router caps verbatim and feed the server's
        // rtpParameters straight into mediasoup, never touching the Codable
        // structs that Skip's JSONEncoder can't round-trip.
        val initialPreference = initialConsumerPreference(
            producerKind = producerKind,
            producerType = producerType,
            preferHighWebcamLayer = preferHighWebcamLayer,
        )
        val response = socket.consumeRaw(
            producerId,
            rtpCapsJson,
            receiveTransportId,
            preferredSpatialLayer = initialPreference.spatialLayer,
            preferredTemporalLayer = initialPreference.temporalLayer,
            priority = initialPreference.priority,
        )
        val consumer = receiveTransport.consume(
            this,
            response.id,
            response.producerId,
            response.kind,
            response.rtpParametersJson
        )
        consumer.resume()

        val isScreenVideo = producerType == "screen" && response.kind == "video"
        val trackKey = if (isScreenVideo) "${producerUserId}-screen" else producerUserId

        consumers[response.id] = ConsumerInfo(
            consumer = consumer,
            producerId = response.producerId,
            userId = producerUserId,
            kind = response.kind,
            type = producerType,
            trackKey = trackKey
        )

        // Request a keyframe on the initial video consume so the decoder gets a
        // fresh IDR immediately instead of a frozen/blank first frame.
        if (response.kind == "video" && producerType == ProducerType.webcam.rawValue) {
            val initialPreference = initialWebcamConsumerPreference(
                preferHighWebcamLayer = preferHighWebcamLayer,
            )
            try {
                socket.setConsumerPreferences(
                    consumerId = response.id,
                    spatialLayer = initialPreference.spatialLayer,
                    temporalLayer = initialPreference.temporalLayer,
                    requestKeyFrame = false
                )
            } catch (_: Throwable) {
            }
        }
        socket.resumeConsumer(response.id, response.kind == "video")

        if (response.kind == "video") {
            val track = consumer.track as? VideoTrack
            val wrapper = VideoTrackWrapper(
                id = response.id,
                userId = trackKey,
                isLocal = false,
                track = track
            )
            remoteVideoTracks[trackKey] = wrapper
        }
    }

    internal fun closeConsumer(producerId: String, userId: String) {
        if (producerId.isEmpty()) {
            val ids = consumers.filterValues { it.userId == userId }.keys.toList()
            ids.forEach { id ->
                consumers[id]?.consumer?.close()
                consumers.remove(id)
                videoFreezeStats.remove(id)
                remoteConsumerPreferenceSignatures.remove(id)
                remoteConsumerLayerPreferenceUnsupportedIds.remove(id)
                remoteConsumerPreferenceInFlightIds.remove(id)
            }
        } else {
            val entry = consumers.entries.firstOrNull { it.value.producerId == producerId }
            if (entry != null) {
                entry.value.consumer.close()
                consumers.remove(entry.key)
                videoFreezeStats.remove(entry.key)
                remoteConsumerPreferenceSignatures.remove(entry.key)
                remoteConsumerLayerPreferenceUnsupportedIds.remove(entry.key)
                remoteConsumerPreferenceInFlightIds.remove(entry.key)
                val key = if (entry.value.trackKey.isEmpty()) entry.value.userId else entry.value.trackKey
                if (entry.value.kind == "video" && key.isNotEmpty()) {
                    remoteVideoTracks.removeValue(forKey = key)
                }
            }
        }

        if (producerId.isEmpty() && userId.isNotEmpty()) {
            remoteVideoTracks.removeValue(forKey = userId)
            remoteVideoTracks.removeValue(forKey = "${userId}-screen")
        }
    }

    internal fun hasAudioConsumer(userIdPrefix: String): Boolean {
        return consumers.values.any { it.kind == "audio" && it.userId.startsWith(userIdPrefix) }
    }

    internal fun setAudioConsumersEnabled(userIdPrefix: String, enabled: Boolean) {
        for (info in consumers.values) {
            if (info.kind != "audio" || !info.userId.startsWith(userIdPrefix)) {
                continue
            }
            (info.consumer.track as? AudioTrack)?.setEnabled(enabled)
        }
    }

    internal suspend fun setAudioEnabled(enabled: Boolean) {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val producer = audioProducer ?: throw ErrorException("Audio producer not ready")
        val previous = localAudioEnabled

        try {
            if (enabled) {
                configureCallAudioMode(unmuted = true)
                producer.resume()
            } else {
                producer.pause()
            }

            socket.toggleMute(producer.id, paused = !enabled)
            localAudioTrack?.setEnabled(enabled)
            localAudioEnabled = enabled
            onLocalAudioEnabledChanged?.invoke(enabled)
        } catch (error: Throwable) {
            if (previous) {
                producer.resume()
            } else {
                producer.pause()
            }
            localAudioTrack?.setEnabled(previous)
            localAudioEnabled = previous
            onLocalAudioEnabledChanged?.invoke(previous)
            debugLog("[WebRTC] Failed to toggle audio: ${error}")
            throw error
        }
    }

    internal suspend fun setVideoEnabled(enabled: Boolean) {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val producer = videoProducer ?: throw ErrorException("Video producer not ready")
        val previous = localVideoEnabled

        try {
            if (enabled) {
                if (androidx.core.content.ContextCompat.checkSelfPermission(ProcessInfo.processInfo.androidContext, android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    throw ErrorException("Camera permission not granted")
                }
                val profile = webcamCaptureProfile(currentVideoQuality, currentLocalBandwidthQuality)
                videoCapturer?.startCapture(profile.width, profile.height, profile.fps)
                producer.resume()
            } else {
                producer.pause()
            }

            socket.toggleCamera(producer.id, paused = !enabled)
            localVideoTrack?.setEnabled(enabled)
            localVideoEnabled = enabled
            localVideoTrackWrapper?.isEnabled = enabled

            if (!enabled) {
                try {
                    videoCapturer?.stopCapture()
                } catch (_: Throwable) {
                }
            }

            onLocalVideoEnabledChanged?.invoke(enabled)
        } catch (error: Throwable) {
            if (previous) {
                producer.resume()
            } else {
                producer.pause()
                try {
                    videoCapturer?.stopCapture()
                } catch (_: Throwable) {
                }
            }
            localVideoTrack?.setEnabled(previous)
            localVideoTrackWrapper?.isEnabled = previous
            localVideoEnabled = previous
            onLocalVideoEnabledChanged?.invoke(previous)
            debugLog("[WebRTC] Failed to toggle video: ${error}")
            throw error
        }
    }

    internal suspend fun closeLocalVideoProducer() {
        val socket = socketManager
        val producerId = videoProducer?.id ?: return

        closeLocalMedia(
            kind = "video",
            type = ProducerType.webcam.rawValue,
            producerId = producerId
        )

        try {
            socket?.closeProducer(producerId)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to notify SFU of closed video producer: ${error}")
        }
    }

    internal suspend fun closeLocalScreenProducer() {
        val socket = socketManager
        val producerId = screenProducer?.id

        stopScreenSharing()

        if (producerId == null) return

        try {
            socket?.closeProducer(producerId)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to notify SFU of closed screen producer: ${error}")
        }
    }

    internal suspend fun closeLocalMedia(kind: String, type: String, producerId: String? = null): Boolean {
        val isWebcam = type == ProducerType.webcam.rawValue
        val isScreen = type == ProducerType.screen.rawValue

        if (kind == "audio" && isWebcam && matchesProducer(audioProducer, producerId)) {
            audioProducer?.close()
            audioProducer = null
            audioProducerBandwidthQuality = ConnectionQuality.unknown
            localAudioTrack?.setEnabled(false)
            localAudioTrack = null
            clearAudioSource()
            localAudioEnabled = false
            onLocalAudioEnabledChanged?.invoke(false)
            return true
        }

        if (kind == "video" && isWebcam && matchesProducer(videoProducer, producerId)) {
            videoProducer?.close()
            videoProducer = null
            videoProducerBandwidthQuality = ConnectionQuality.unknown
            videoProducerBandwidthSignature = null
            localVideoTrack?.setEnabled(false)
            localVideoTrackWrapper?.isEnabled = false
            localVideoTrackWrapper = null
            localVideoTrack = null
            try {
                videoCapturer?.stopCapture()
            } catch (_: Throwable) {
            }
            videoCapturer?.dispose()
            videoCapturer = null
            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = null
            clearVideoSource()
            localVideoEnabled = false
            onLocalVideoEnabledChanged?.invoke(false)
            return true
        }

        if (kind == "video" && isScreen && matchesProducer(screenProducer, producerId)) {
            stopScreenSharing()
            screenProducerBandwidthQuality = ConnectionQuality.unknown
            return true
        }

        return false
    }

    private suspend fun ensureRecordAudioPermission(): Boolean {
        if (PermissionHelper.hasRecordAudioPermission()) return true

        return suspendCancellableCoroutine { cont ->
            if (PermissionHelper.onRecordAudioPermissionResult != null) {
                cont.resume(false)
                return@suspendCancellableCoroutine
            }

            val callback: (Boolean) -> Unit = { granted ->
                if (cont.isActive) {
                    cont.resume(granted)
                }
            }
            PermissionHelper.onRecordAudioPermissionResult = callback
            cont.invokeOnCancellation {
                if (PermissionHelper.onRecordAudioPermissionResult === callback) {
                    PermissionHelper.onRecordAudioPermissionResult = null
                }
            }
            PermissionHelper.requestRecordAudioPermission()
        }
    }

    private suspend fun ensureCameraPermission(): Boolean {
        if (PermissionHelper.hasCameraPermission()) return true

        return suspendCancellableCoroutine { cont ->
            if (PermissionHelper.onCameraPermissionResult != null) {
                cont.resume(false)
                return@suspendCancellableCoroutine
            }

            val callback: (Boolean) -> Unit = { granted ->
                if (cont.isActive) {
                    cont.resume(granted)
                }
            }
            PermissionHelper.onCameraPermissionResult = callback
            cont.invokeOnCancellation {
                if (PermissionHelper.onCameraPermissionResult === callback) {
                    PermissionHelper.onCameraPermissionResult = null
                }
            }
            PermissionHelper.requestCameraPermission()
        }
    }

    private fun clearAudioSource() {
        audioSource?.dispose()
        audioSource = null
    }

    private fun microphoneAudioConstraints(): MediaConstraints {
        return MediaConstraints().apply {
            optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
        }
    }

    private fun clearVideoSource() {
        videoSource?.dispose()
        videoSource = null
    }

    private fun clearScreenVideoSource() {
        screenVideoSource?.dispose()
        screenVideoSource = null
    }

    private fun matchesProducer(producer: Producer?, producerId: String?): Boolean {
        return producer != null && (producerId == null || producer.id == producerId)
    }

    private fun preferredVideoCodecJson(mimeType: String = "video/VP8"): String? {
        val loadedDevice = device ?: return null
        return try {
            val codecs = JSONObject(loadedDevice.getRtpCapabilities())
                .optJSONArray("codecs")
                ?: return null
            for (index in 0 until codecs.length()) {
                val codec = codecs.optJSONObject(index) ?: continue
                val kind = codec.optString("kind")
                val codecMimeType = codec.optString("mimeType")
                if (
                    (kind.isEmpty() || kind.equals("video", ignoreCase = true)) &&
                    codecMimeType.equals(mimeType, ignoreCase = true)
                ) {
                    return codec.toString()
                }
            }
            null
        } catch (_: Throwable) {
            null
        }
    }

    private fun produceWebcamVideo(
        transport: SendTransport,
        track: VideoTrack,
        appData: String,
        connectionQuality: ConnectionQuality,
    ): Producer {
        val mediaTrack = track as MediaStreamTrack
        val preferredCodec = preferredVideoCodecJson()
        return try {
            transport.produce(
                this,
                mediaTrack,
                webcamEncodings(currentVideoQuality, connectionQuality),
                null,
                preferredCodec,
                appData
            )
        } catch (error: Throwable) {
            android.util.Log.w(
                "ConclaveWebRTC",
                "Webcam simulcast produce failed; retrying single-layer",
                error
            )
            transport.produce(
                this,
                mediaTrack,
                null as List<RtpParameters.Encoding>?,
                null,
                null,
                appData
            )
        }
    }

    internal fun updateVideoQuality(quality: VideoQuality) {
        currentVideoQuality = quality
        lastAppliedLocalBandwidthSignature = null
        applyLocalBandwidthProfile(currentLocalBandwidthQuality)
        val producer = videoProducer ?: return
        try {
            producer.setMaxSpatialLayer(
                webcamMaxSpatialLayer(quality, currentLocalBandwidthQuality)
            )
        } catch (_: Throwable) {
        }
        if (localVideoEnabled) {
            val profile = webcamCaptureProfile(quality, currentLocalBandwidthQuality)
            try {
                videoCapturer?.changeCaptureFormat(profile.width, profile.height, profile.fps)
            } catch (_: Throwable) {
            }
        }
    }

    internal fun applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) {
        val signature = "${currentVideoQuality}:${connectionQuality}"
        if (lastAppliedLocalBandwidthSignature == signature) return
        currentLocalBandwidthQuality = connectionQuality
        lastAppliedLocalBandwidthSignature = signature

        videoProducer?.let { producer ->
            try {
                producer.setMaxSpatialLayer(
                    webcamMaxSpatialLayer(currentVideoQuality, connectionQuality)
                )
            } catch (_: Throwable) {
            }
        }

        if (localVideoEnabled) {
            val profile = webcamCaptureProfile(currentVideoQuality, connectionQuality)
            try {
                videoCapturer?.changeCaptureFormat(profile.width, profile.height, profile.fps)
            } catch (_: Throwable) {
            }
        }

        if (screenProducer != null && screenCapturer != null) {
            val metrics = ProcessInfo.processInfo.androidContext.resources.displayMetrics
            val cap = screenShareEncodingCap(connectionQuality)
            try {
                screenCapturer?.changeCaptureFormat(
                    metrics.widthPixels,
                    metrics.heightPixels,
                    cap.maxFramerate,
                )
            } catch (_: Throwable) {
            }
        }
    }

    internal suspend fun refreshLocalVideoProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ) {
        if (videoBandwidthRefreshInFlight) return
        if (!shouldRefreshVideoProducerForBandwidthProfile(connectionQuality)) return

        val socket = socketManager ?: return
        val transport = sendTransport ?: return
        val oldProducer = videoProducer ?: return
        val track = localVideoTrack ?: return
        videoBandwidthRefreshInFlight = true
        try {
            val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
            val nextProducer = produceWebcamVideo(transport, track, appData, connectionQuality)
            nextProducer.resume()
            try {
                nextProducer.setMaxSpatialLayer(
                    webcamMaxSpatialLayer(currentVideoQuality, connectionQuality)
                )
            } catch (_: Throwable) {
            }
            videoProducer = nextProducer
            videoProducerBandwidthQuality = connectionQuality
            videoProducerBandwidthSignature = localVideoBandwidthSignature(
                currentVideoQuality,
                connectionQuality,
            )
            localVideoEnabled = true
            localVideoTrackWrapper?.isEnabled = true

            try {
                socket.closeProducer(oldProducer.id)
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to notify SFU of refreshed webcam producer close: ${error}")
            }
            oldProducer.close()
            debugLog("[WebRTC] Refreshed webcam producer for ${connectionQuality} bandwidth")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to refresh webcam producer for bandwidth: ${error}")
        } finally {
            videoBandwidthRefreshInFlight = false
        }
    }

    internal suspend fun refreshLocalAudioProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ) {
        if (audioBandwidthRefreshInFlight) return
        if (!shouldRefreshAudioProducerForBandwidthProfile(connectionQuality)) return

        val socket = socketManager ?: return
        val oldProducerId = audioProducer?.id ?: return
        audioBandwidthRefreshInFlight = true
        val callback = onLocalAudioEnabledChanged
        onLocalAudioEnabledChanged = null
        try {
            // Android's mediasoup Producer does not expose live RtpSender
            // parameters. Re-producing the mic is the only reliable way to
            // apply stricter Opus maxaveragebitrate after a network downgrade.
            socket.closeProducer(oldProducerId)
            closeLocalMedia(
                kind = "audio",
                type = ProducerType.webcam.rawValue,
                producerId = oldProducerId,
            )
            startProducingAudio()
            debugLog("[WebRTC] Refreshed microphone producer for ${connectionQuality} bandwidth")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to refresh microphone producer for bandwidth: ${error}")
        } finally {
            onLocalAudioEnabledChanged = callback
            audioBandwidthRefreshInFlight = false
            if (!localAudioEnabled) {
                callback?.invoke(false)
            }
        }
    }

    internal suspend fun refreshLocalScreenProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ) {
        if (screenBandwidthRefreshInFlight) return
        if (!shouldRefreshScreenProducerForBandwidthProfile(connectionQuality)) return

        val socket = socketManager ?: return
        val transport = sendTransport ?: return
        val oldProducer = screenProducer ?: return
        val track = screenVideoTrack ?: return
        screenBandwidthRefreshInFlight = true
        try {
            val appData = encodeJSONString(ProducerAppData(type = ProducerType.screen.rawValue, paused = false))
            val preferredCodec = preferredVideoCodecJson()
            val nextProducer = transport.produce(
                this,
                track as MediaStreamTrack,
                screenShareEncodings(connectionQuality),
                null,
                preferredCodec,
                appData,
            )
            nextProducer.resume()
            screenProducer = nextProducer
            screenProducerBandwidthQuality = connectionQuality

            try {
                socket.closeProducer(oldProducer.id)
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to notify SFU of refreshed screen producer close: ${error}")
            }
            oldProducer.close()
            debugLog("[WebRTC] Refreshed screen producer for ${connectionQuality} bandwidth")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to refresh screen producer for bandwidth: ${error}")
        } finally {
            screenBandwidthRefreshInFlight = false
        }
    }

    private fun shouldRefreshAudioProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ): Boolean {
        if (connectionQuality == ConnectionQuality.unknown) {
            return false
        }
        if (audioProducer == null || !localAudioEnabled || localAudioTrack?.enabled() != true) {
            return false
        }
        return connectionQuality != audioProducerBandwidthQuality
    }

    private fun localVideoBandwidthSignature(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality,
    ): String = "${quality}:${connectionQuality}"

    private fun shouldRefreshVideoProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ): Boolean {
        if (connectionQuality == ConnectionQuality.unknown) {
            return false
        }
        if (videoProducer == null || !localVideoEnabled || localVideoTrack?.enabled() != true) {
            return false
        }
        val nextSignature = localVideoBandwidthSignature(currentVideoQuality, connectionQuality)
        return connectionQualityRank(connectionQuality) > connectionQualityRank(videoProducerBandwidthQuality) ||
            videoProducerBandwidthSignature != nextSignature
    }

    private fun shouldRefreshScreenProducerForBandwidthProfile(
        connectionQuality: ConnectionQuality,
    ): Boolean {
        if (connectionQuality == ConnectionQuality.unknown) {
            return false
        }
        if (screenProducer == null || screenVideoTrack == null || screenCapturer == null) {
            return false
        }
        return connectionQuality != screenProducerBandwidthQuality
    }

    private fun connectionQualityRank(quality: ConnectionQuality): Int {
        return when (quality) {
            ConnectionQuality.unknown -> 0
            ConnectionQuality.good -> 1
            ConnectionQuality.fair -> 2
            ConnectionQuality.poor -> 3
            ConnectionQuality.emergency -> 4
        }
    }

    private fun webcamCaptureProfile(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
    ): WebcamCaptureProfile {
        if (connectionQuality == ConnectionQuality.emergency) {
            return WebcamCaptureProfile(width = 640, height = 360, fps = 8)
        }
        if (connectionQuality == ConnectionQuality.poor) {
            return WebcamCaptureProfile(width = 640, height = 360, fps = 12)
        }
        if (connectionQuality == ConnectionQuality.fair || quality == VideoQuality.low) {
            return WebcamCaptureProfile(width = 640, height = 360, fps = 20)
        }

        return when (quality) {
            VideoQuality.low -> WebcamCaptureProfile(width = 640, height = 360, fps = 20)
            VideoQuality.standard -> WebcamCaptureProfile(width = 1280, height = 720, fps = 30)
        }
    }

    private fun webcamEncodingSpecs(quality: VideoQuality): List<WebcamEncodingSpec> {
        return when (quality) {
            VideoQuality.low -> listOf(
                WebcamEncodingSpec(rid = "q", scaleResolutionDownBy = 2.0, maxBitrateBps = 65_000, maxFramerate = 8),
                WebcamEncodingSpec(rid = "h", scaleResolutionDownBy = 1.0, maxBitrateBps = 120_000, maxFramerate = 12),
                WebcamEncodingSpec(rid = "f", scaleResolutionDownBy = 1.0, maxBitrateBps = 180_000, maxFramerate = 15),
            )
            VideoQuality.standard -> listOf(
                WebcamEncodingSpec(rid = "q", scaleResolutionDownBy = 4.0, maxBitrateBps = 90_000, maxFramerate = 12),
                WebcamEncodingSpec(rid = "h", scaleResolutionDownBy = 2.0, maxBitrateBps = 260_000, maxFramerate = 20),
                WebcamEncodingSpec(rid = "f", scaleResolutionDownBy = 1.0, maxBitrateBps = 1_500_000, maxFramerate = 30),
            )
        }
    }

    private fun webcamEncodingSpecs(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality,
    ): List<WebcamEncodingSpec> {
        val base = webcamEncodingSpecs(quality)
        val bitrateCaps: List<Int>
        val framerateCaps: List<Int>
        when (connectionQuality) {
            ConnectionQuality.emergency -> {
                bitrateCaps = listOf(65_000, 90_000, 120_000)
                framerateCaps = listOf(8, 8, 8)
            }
            ConnectionQuality.poor -> {
                bitrateCaps = listOf(120_000, 160_000, 180_000)
                framerateCaps = listOf(12, 12, 15)
            }
            ConnectionQuality.fair -> {
                bitrateCaps = listOf(90_000, 220_000, 420_000)
                framerateCaps = listOf(10, 15, 20)
            }
            ConnectionQuality.good, ConnectionQuality.unknown -> return base
        }

        return base.mapIndexed { index, spec ->
            val scaleResolutionDownBy =
                if (
                    index == 0 &&
                    (
                        connectionQuality == ConnectionQuality.emergency ||
                            connectionQuality == ConnectionQuality.poor
                    )
                ) {
                    minOf(spec.scaleResolutionDownBy, 2.0)
                } else {
                    spec.scaleResolutionDownBy
                }
            WebcamEncodingSpec(
                rid = spec.rid,
                scaleResolutionDownBy = scaleResolutionDownBy,
                maxBitrateBps = minOf(spec.maxBitrateBps, bitrateCaps[minOf(index, bitrateCaps.size - 1)]),
                maxFramerate = minOf(spec.maxFramerate, framerateCaps[minOf(index, framerateCaps.size - 1)]),
            )
        }
    }

    private fun webcamEncodings(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
    ): List<RtpParameters.Encoding> {
        return webcamEncodingSpecs(quality, connectionQuality).mapIndexed { index, spec ->
            RtpParameters.Encoding(
                spec.rid,
                shouldSendWebcamEncoding(index, quality, connectionQuality),
                spec.scaleResolutionDownBy,
            ).also { encoding ->
                encoding.maxBitrateBps = spec.maxBitrateBps
                encoding.maxFramerate = spec.maxFramerate
                encoding.networkPriority = 0
            }
        }
    }

    private fun webcamMaxSpatialLayer(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
    ): Int {
        val base = when (quality) {
            VideoQuality.low -> 1
            VideoQuality.standard -> 2
        }
        if (connectionQuality == ConnectionQuality.emergency || connectionQuality == ConnectionQuality.poor) return 0
        if (connectionQuality == ConnectionQuality.fair || quality == VideoQuality.low) {
            return minOf(base, 1)
        }
        return base
    }

    private fun shouldSendWebcamEncoding(
        layerIndex: Int,
        quality: VideoQuality,
        connectionQuality: ConnectionQuality,
    ): Boolean {
        if (
            connectionQuality == ConnectionQuality.good ||
            connectionQuality == ConnectionQuality.unknown
        ) {
            return true
        }

        return layerIndex <= webcamMaxSpatialLayer(quality, connectionQuality)
    }

    private fun screenShareEncodingCap(
        connectionQuality: ConnectionQuality,
    ): ScreenShareEncodingCap {
        return when (connectionQuality) {
            ConnectionQuality.emergency -> ScreenShareEncodingCap(maxBitrateBps = 220_000, maxFramerate = 3)
            ConnectionQuality.poor -> ScreenShareEncodingCap(maxBitrateBps = 450_000, maxFramerate = 5)
            ConnectionQuality.fair -> ScreenShareEncodingCap(maxBitrateBps = 1_200_000, maxFramerate = 12)
            ConnectionQuality.good, ConnectionQuality.unknown -> ScreenShareEncodingCap(maxBitrateBps = 2_500_000, maxFramerate = 24)
        }
    }

    private fun screenShareEncodings(
        connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
    ): List<RtpParameters.Encoding> {
        val cap = screenShareEncodingCap(connectionQuality)
        return listOf(
            RtpParameters.Encoding(null, true, 1.0).also { encoding ->
                encoding.maxBitrateBps = cap.maxBitrateBps
                encoding.maxFramerate = cap.maxFramerate
                encoding.numTemporalLayers = screenShareTemporalLayerCount
            },
        )
    }

    private fun microphoneOpusCodecOptionsJson(): String {
        return JSONObject()
            .put("opusStereo", false)
            .put("opusFec", true)
            .put("opusDtx", true)
            .put("opusMaxAverageBitrate", opusMaxAverageBitrate(currentLocalBandwidthQuality))
            .put("opusPtime", 20)
            .toString()
    }

    private fun opusMaxAverageBitrate(connectionQuality: ConnectionQuality): Int {
        return when (connectionQuality) {
            ConnectionQuality.emergency -> 18_000
            ConnectionQuality.poor -> 24_000
            ConnectionQuality.fair -> 32_000
            ConnectionQuality.good, ConnectionQuality.unknown -> 48_000
        }
    }

    internal suspend fun cleanup(notifyLocalState: Boolean = true) {
        configurationGeneration += 1
        try {
            videoCapturer?.stopCapture()
        } catch (_: Throwable) {
        }
        videoCapturer?.dispose()
        videoCapturer = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null

        try {
            screenCapturer?.stopCapture()
        } catch (_: Throwable) {
        }
        screenCapturer?.dispose()
        screenCapturer = null
        screenSurfaceTextureHelper?.dispose()
        screenSurfaceTextureHelper = null
        clearScreenVideoSource()
        screenVideoTrack = null

        audioProducer?.close()
        videoProducer?.close()
        screenProducer?.close()
        audioProducer = null
        videoProducer = null
        screenProducer = null
        currentLocalBandwidthQuality = ConnectionQuality.unknown
        audioProducerBandwidthQuality = ConnectionQuality.unknown
        videoProducerBandwidthQuality = ConnectionQuality.unknown
        videoProducerBandwidthSignature = null
        screenProducerBandwidthQuality = ConnectionQuality.unknown
        audioBandwidthRefreshInFlight = false
        videoBandwidthRefreshInFlight = false
        screenBandwidthRefreshInFlight = false
        lastAppliedLocalBandwidthSignature = null

        consumers.values.forEach { it.consumer.close() }
        consumers.clear()
        videoFreezeStats.clear()
        remoteConsumerPreferenceSignatures.clear()
        remoteConsumerLayerPreferenceUnsupportedIds.clear()
        remoteConsumerPreferenceInFlightIds.clear()
        remoteConsumerPreferenceRetryJob?.cancel()
        remoteConsumerPreferenceRetryJob = null
        previousPublishConnectionLossSample = null
        previousReceiveConnectionLossSample = null
        previousPublishMediaCounterSample = null
        previousReceiveMediaCounterSample = null

        localVideoTrack?.setEnabled(false)
        localAudioTrack?.setEnabled(false)
        localVideoTrack = null
        localAudioTrack = null
        clearVideoSource()
        clearAudioSource()
        releaseCallAudioMode()

        // Reset the produce-state flags (mirrors the Swift WebRTCClient.cleanup
        // fix). The client is reused across calls via the singleton VM, so a
        // stale-true flag would make the next join's unmute / camera-on take the
        // resume branch against a now-null producer and silently produce nothing.
        localAudioEnabled = false
        localVideoEnabled = false
        // On a rejoin (notifyLocalState=false) skip the change callbacks so they
        // don't clobber the user's preserved mute/camera intent before
        // startProducing re-publishes (mirrors the Swift suppression).
        if (notifyLocalState) {
            onLocalAudioEnabledChanged?.invoke(false)
            onLocalVideoEnabledChanged?.invoke(false)
        }

        localVideoTrackWrapper = null
        remoteVideoTracks.removeAll()

        sendTransport?.close()
        receiveTransport?.close()
        sendTransport = null
        receiveTransport = null
        transportConnectionStates.clear()
        device?.dispose()
        device = null
        runtimeIceServersJSON = null
    }

    internal fun getCaptureSession(): Any? = null
    internal fun getLocalVideoTrack(): Any? = localVideoTrackWrapper

    /// The raw org.webrtc.VideoTrack for a participant's webcam (by user id), or
    /// the local camera track when `userId == "local"`. Used to feed the
    /// Picture-in-Picture window the active speaker's video.
    internal fun rawVideoTrack(userId: String): VideoTrack? {
        if (userId == "local") {
            return localVideoTrack
        }
        return remoteVideoTracks[userId]?.rtcVideoTrack
    }

    // MARK: - Audio Device Routing

    private fun audioManager(): AudioManager? {
        val context = ProcessInfo.processInfo.androidContext
        return context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    }

    private fun configureCallAudioMode(unmuted: Boolean = false) {
        val manager = audioManager() ?: return
        try {
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            if (unmuted) {
                manager.isMicrophoneMute = false
            }
            applyPreferredCommunicationRoute(manager)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to configure call audio mode: ${error}")
        }
    }

    private fun releaseCallAudioMode() {
        val manager = audioManager() ?: return
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                manager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                manager.stopBluetoothSco()
                @Suppress("DEPRECATION")
                manager.isBluetoothScoOn = false
                @Suppress("DEPRECATION")
                manager.isSpeakerphoneOn = false
            }
            manager.mode = AudioManager.MODE_NORMAL
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to release call audio mode: ${error}")
        }
    }

    // Friendly label for an AudioDeviceInfo type, mirroring the route names the
    // web/iOS clients surface (Speaker / Earpiece / Bluetooth / Wired headset).
    private fun deviceLabel(info: AudioDeviceInfo): String {
        return when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> {
                val name = info.productName?.toString()
                if (name.isNullOrBlank()) "Bluetooth" else name
            }
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headset"
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB audio"
            else -> {
                val name = info.productName?.toString()
                if (name.isNullOrBlank()) "Audio device" else name
            }
        }
    }

    private fun isExternalCallRoute(info: AudioDeviceInfo): Boolean {
        return when (info.type) {
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> true
            else -> false
        }
    }

    private fun applyPreferredCommunicationRoute(manager: AudioManager) {
        val selected = selectedAudioOutputDeviceId
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = manager.availableCommunicationDevices
            val target = when {
                !selected.isNullOrBlank() -> devices.firstOrNull { it.id.toString() == selected }
                else -> devices.firstOrNull { isExternalCallRoute(it) }
                    ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            }
            try {
                if (target != null) {
                    manager.setCommunicationDevice(target)
                } else {
                    manager.clearCommunicationDevice()
                }
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to apply communication route: ${error}")
            }
            return
        }

        @Suppress("DEPRECATION")
        if (!selected.isNullOrBlank()) {
            val target = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .firstOrNull { it.id.toString() == selected }
            val useSpeaker = target?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            manager.isSpeakerphoneOn = useSpeaker
            setBluetoothScoEnabled(manager, target?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            return
        }

        val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val external = outputs.firstOrNull { isExternalCallRoute(it) }
        @Suppress("DEPRECATION")
        manager.isSpeakerphoneOn = external == null
        setBluetoothScoEnabled(manager, external?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    }

    private fun setBluetoothScoEnabled(manager: AudioManager, enabled: Boolean) {
        @Suppress("DEPRECATION")
        try {
            manager.isBluetoothScoOn = enabled
            if (enabled) {
                manager.startBluetoothSco()
            } else {
                manager.stopBluetoothSco()
            }
        } catch (_: Throwable) {
        }
    }

    internal fun availableAudioInputs(): skip.lib.Array<AudioDevice> {
        return skip.lib.Array()
    }

    internal fun availableAudioOutputs(): skip.lib.Array<AudioDevice> {
        val manager = audioManager() ?: return skip.lib.Array()
        val out = mutableListOf<AudioDevice>()
        val seen = mutableSetOf<String>()
        for (info in manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            // Telephony / aux / unknown sinks aren't useful pick targets.
            if (info.type == AudioDeviceInfo.TYPE_TELEPHONY) {
                continue
            }
            val label = deviceLabel(info)
            if (seen.add(label)) {
                out.add(AudioDevice(id = info.id.toString(), label = label))
            }
        }
        return skip.lib.Array(out)
    }

    internal fun currentAudioInputId(): String? {
        return null
    }

    internal fun currentAudioOutputId(): String? {
        val manager = audioManager() ?: return null
        if (Build.VERSION.SDK_INT >= 31) {
            val device = manager.communicationDevice ?: return null
            return device.id.toString()
        }
        // Pre-31: speaker vs earpiece is the only thing we can read back.
        val speakerOn = manager.isSpeakerphoneOn
        val devices = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val wanted = if (speakerOn) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        return devices.firstOrNull { it.type == wanted }?.id?.toString()
    }

    internal fun selectAudioInput(deviceId: String) {
        // Android's public call-routing API selects an overall communication
        // route, not an independent microphone. Speaker routing handles it.
    }

    internal fun selectAudioOutput(deviceId: String) {
        val manager = audioManager() ?: return
        selectedAudioOutputDeviceId = deviceId.trim().ifEmpty { null }
        // Audio routing only takes effect while the session is in communication
        // mode (the call mode). Set it defensively; the WebRTC ADM also uses it.
        manager.mode = AudioManager.MODE_IN_COMMUNICATION

        if (deviceId.isBlank()) {
            applyPreferredCommunicationRoute(manager)
            return
        }

        if (Build.VERSION.SDK_INT >= 31) {
            routeCommunicationDevice(deviceId)
            return
        }

        // Pre-31 fallback: only speaker vs earpiece is reliably controllable.
        val devices = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val target = devices.firstOrNull { it.id.toString() == deviceId }
        manager.isSpeakerphoneOn = target?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }

    private fun routeCommunicationDevice(deviceId: String) {
        val manager = audioManager() ?: return
        if (Build.VERSION.SDK_INT < 31) return
        val devices = manager.availableCommunicationDevices
        val target = devices.firstOrNull { it.id.toString() == deviceId }
        if (target != null) {
            try {
                manager.setCommunicationDevice(target)
            } catch (_: Throwable) {
            }
        } else {
            manager.clearCommunicationDevice()
        }
    }

    // Plays a short DTMF/beep through the active output so the user can confirm
    // the selected speaker is audible (mirrors web's "Test speaker").
    internal fun testSpeaker() {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
            // Release after the tone finishes so the generator isn't leaked.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                tone.release()
            }, 400L)
        } catch (_: Throwable) {
        }
    }

    private val outgoingBandwidthFairBps = 500_000.0
    private val outgoingBandwidthPoorBps = 240_000.0
    private val outgoingBandwidthEmergencyBps = 120_000.0
    private val incomingBandwidthFairBps = 500_000.0
    private val incomingBandwidthPoorBps = 240_000.0
    private val incomingBandwidthEmergencyBps = 120_000.0
    private val availableBitrateSaturationRatio = 0.7

    private data class ConnectionLossSample(
        val packetsLost: Double,
        val packetsReceived: Double,
    )

    private data class ConnectionStatsSample(
        val rttMs: Double?,
        val inboundJitterMs: Double?,
        val inboundJitterWeight: Double,
        val inboundPacketsLost: Double,
        val inboundPacketsReceived: Double,
        val remoteInboundJitterMs: Double?,
        val remoteInboundJitterWeight: Double,
        val remoteInboundPacketsLost: Double,
        val remoteInboundPacketsReceived: Double,
        val remoteInboundLossFraction: Double?,
        val availableOutgoingBitrate: Double?,
        val availableIncomingBitrate: Double?,
        val outboundMediaBytes: Double?,
        val inboundMediaBytes: Double?,
        val outboundVideoQualityLimitationReason: String?,
    )

    private data class MediaCounterSample(
        val timestampMs: Double,
        val mediaBytes: Double?,
    )

    private data class DirectionConnectionStats(
        var rttMs: Double? = null,
        var jitterWeightedMs: Double = 0.0,
        var jitterWeight: Double = 0.0,
        var packetsLost: Double = 0.0,
        var packetsReceived: Double = 0.0,
        var lossFraction: Double? = null,
        var availableBitrate: Double? = null,
        var mediaBytes: Double? = null,
        var outboundVideoQualityLimitationReason: String? = null,
    ) {
        val jitterMs: Double?
            get() = if (jitterWeight > 0.0) jitterWeightedMs / jitterWeight else null

        fun mergeRtt(value: Double?) {
            value ?: return
            rttMs = if (rttMs == null) value else kotlin.math.max(rttMs ?: value, value)
        }

        fun mergeJitter(value: Double?, weight: Double) {
            value ?: return
            val safeWeight = kotlin.math.max(1.0, weight)
            jitterWeightedMs += value * safeWeight
            jitterWeight += safeWeight
        }

        fun mergePacketCounters(lost: Double, received: Double) {
            packetsLost += lost
            packetsReceived += received
        }

        fun mergeLossFraction(value: Double?) {
            value ?: return
            lossFraction = if (lossFraction == null) value else kotlin.math.max(lossFraction ?: value, value)
        }
    }

    private var previousPublishConnectionLossSample: ConnectionLossSample? = null
    private var previousReceiveConnectionLossSample: ConnectionLossSample? = null
    private var previousPublishMediaCounterSample: MediaCounterSample? = null
    private var previousReceiveMediaCounterSample: MediaCounterSample? = null

    internal fun sampleConnectionQuality(): ConnectionQuality {
        return sampleConnectionQualitySample().overallQuality
    }

    internal fun sampleConnectionQualitySample(): ConnectionQualitySample {
        val publish = DirectionConnectionStats()
        val receive = DirectionConnectionStats()
        var hasPublishStats = false
        var hasReceiveStats = false

        val send = sendTransport
        if (send != null && !send.isClosed) {
            val sample = try {
                parseConnectionStats(send.getStats())
            } catch (_: Throwable) {
                null
            }
            if (sample != null) {
                hasPublishStats = true
                publish.mergeRtt(sample.rttMs)
                publish.mergeJitter(sample.remoteInboundJitterMs, sample.remoteInboundJitterWeight)
                publish.mergePacketCounters(
                    sample.remoteInboundPacketsLost,
                    sample.remoteInboundPacketsReceived,
                )
                publish.mergeLossFraction(sample.remoteInboundLossFraction)
                publish.availableBitrate = minPositiveNullable(
                    publish.availableBitrate,
                    sample.availableOutgoingBitrate,
                )
                publish.mediaBytes = addNullable(publish.mediaBytes, sample.outboundMediaBytes)
                publish.outboundVideoQualityLimitationReason = selectQualityLimitationReason(
                    publish.outboundVideoQualityLimitationReason,
                    sample.outboundVideoQualityLimitationReason,
                )
            }
        }
        if (!hasPublishStats) {
            previousPublishConnectionLossSample = null
            previousPublishMediaCounterSample = null
        }

        val receiveTransportValue = receiveTransport
        if (receiveTransportValue != null && !receiveTransportValue.isClosed) {
            val sample = try {
                parseConnectionStats(receiveTransportValue.getStats())
            } catch (_: Throwable) {
                null
            }
            if (sample != null) {
                hasReceiveStats = true
                receive.mergeRtt(sample.rttMs)
                receive.mergeJitter(sample.inboundJitterMs, sample.inboundJitterWeight)
                receive.mergePacketCounters(
                    sample.inboundPacketsLost,
                    sample.inboundPacketsReceived,
                )
                receive.availableBitrate = minPositiveNullable(
                    receive.availableBitrate,
                    sample.availableIncomingBitrate,
                )
                receive.mediaBytes = addNullable(receive.mediaBytes, sample.inboundMediaBytes)
            }
        }
        if (!hasReceiveStats) {
            previousReceiveConnectionLossSample = null
            previousReceiveMediaCounterSample = null
        }

        if (!hasPublishStats && !hasReceiveStats) {
            return ConnectionQualitySample(
                publishQuality = ConnectionQuality.unknown,
                receiveQuality = ConnectionQuality.unknown,
                overallQuality = ConnectionQuality.unknown,
            )
        }

        val publishPacketLoss = publish.lossFraction ?: windowedPacketLoss(
            current = ConnectionLossSample(publish.packetsLost, publish.packetsReceived),
            previous = previousPublishConnectionLossSample,
        )
        val receivePacketLoss = windowedPacketLoss(
            current = ConnectionLossSample(receive.packetsLost, receive.packetsReceived),
            previous = previousReceiveConnectionLossSample,
        )
        if (hasPublishStats) {
            previousPublishConnectionLossSample = ConnectionLossSample(
                publish.packetsLost,
                publish.packetsReceived,
            )
        }
        if (hasReceiveStats) {
            previousReceiveConnectionLossSample = ConnectionLossSample(
                receive.packetsLost,
                receive.packetsReceived,
            )
        }

        val nowMs = System.currentTimeMillis().toDouble()
        val publishMediaSample = MediaCounterSample(nowMs, publish.mediaBytes)
        val receiveMediaSample = MediaCounterSample(nowMs, receive.mediaBytes)
        val publishMediaBitrate = windowedBitrate(
            currentBytes = publishMediaSample.mediaBytes,
            previousBytes = previousPublishMediaCounterSample?.mediaBytes,
            elapsedMs = previousPublishMediaCounterSample?.let {
                publishMediaSample.timestampMs - it.timestampMs
            } ?: 0.0,
        )
        val receiveMediaBitrate = windowedBitrate(
            currentBytes = receiveMediaSample.mediaBytes,
            previousBytes = previousReceiveMediaCounterSample?.mediaBytes,
            elapsedMs = previousReceiveMediaCounterSample?.let {
                receiveMediaSample.timestampMs - it.timestampMs
            } ?: 0.0,
        )
        if (hasPublishStats) {
            previousPublishMediaCounterSample = publishMediaSample
        }
        if (hasReceiveStats) {
            previousReceiveMediaCounterSample = receiveMediaSample
        }

        val publishTransportQuality = if (hasPublishStats) {
            deriveConnectionQuality(publish.rttMs, publishPacketLoss, publish.jitterMs)
        } else {
            ConnectionQuality.unknown
        }
        val receiveTransportQuality = if (hasReceiveStats) {
            deriveConnectionQuality(receive.rttMs, receivePacketLoss, receive.jitterMs)
        } else {
            ConnectionQuality.unknown
        }
        val publishBandwidthQuality = deriveAvailableBitrateQuality(
            availableBitrate = publish.availableBitrate,
            mediaBitrate = publishMediaBitrate,
            fairBitrate = outgoingBandwidthFairBps,
            poorBitrate = outgoingBandwidthPoorBps,
            emergencyBitrate = outgoingBandwidthEmergencyBps,
            encoderLimited = hasEncoderQualityLimitation(publish.outboundVideoQualityLimitationReason),
        )
        val receiveBandwidthQuality = deriveAvailableBitrateQuality(
            availableBitrate = receive.availableBitrate,
            mediaBitrate = receiveMediaBitrate,
            fairBitrate = incomingBandwidthFairBps,
            poorBitrate = incomingBandwidthPoorBps,
            emergencyBitrate = incomingBandwidthEmergencyBps,
            encoderLimited = false,
        )

        val publishQuality = worstConnectionQuality(
            publishTransportQuality,
            publishBandwidthQuality,
        )
        val receiveQuality = worstConnectionQuality(
            receiveTransportQuality,
            receiveBandwidthQuality,
        )
        return ConnectionQualitySample(
            publishQuality = publishQuality,
            receiveQuality = receiveQuality,
            overallQuality = worstConnectionQuality(publishQuality, receiveQuality),
        )
    }

    private fun parseConnectionStats(statsJson: String): ConnectionStatsSample? {
        val array = try {
            JSONArray(statsJson)
        } catch (_: Throwable) {
            return null
        }

        var rttMs: Double? = null
        var candidatePairRttMs: Double? = null
        var inboundJitterWeightedMs = 0.0
        var inboundJitterWeight = 0.0
        var inboundPacketsLost = 0.0
        var inboundPacketsReceived = 0.0
        var remoteInboundJitterWeightedMs = 0.0
        var remoteInboundJitterWeight = 0.0
        var remoteInboundPacketsLost = 0.0
        var remoteInboundPacketsReceived = 0.0
        var remoteInboundLossFraction: Double? = null
        var availableOutgoingBitrate: Double? = null
        var availableIncomingBitrate: Double? = null
        var outboundMediaBytes: Double? = null
        var inboundMediaBytes: Double? = null
        var outboundVideoQualityLimitationReason: String? = null
        var foundMetric = false

        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            when (obj.optString("type")) {
                "candidate-pair" -> {
                    val nominated = obj.optBoolean("nominated", false) ||
                        obj.optString("state") == "succeeded"
                    val rtt = jsonNumber(obj, "currentRoundTripTime")
                    if (nominated && rtt != null) {
                        candidatePairRttMs = maxNullable(candidatePairRttMs, rtt * 1000.0)
                        foundMetric = true
                    }
                    val outgoing = jsonNumber(obj, "availableOutgoingBitrate")
                    if (nominated && outgoing != null && outgoing > 0.0) {
                        availableOutgoingBitrate = minPositiveNullable(
                            availableOutgoingBitrate,
                            outgoing,
                        )
                        foundMetric = true
                    }
                    val incoming = jsonNumber(obj, "availableIncomingBitrate")
                    if (nominated && incoming != null && incoming > 0.0) {
                        availableIncomingBitrate = minPositiveNullable(
                            availableIncomingBitrate,
                            incoming,
                        )
                        foundMetric = true
                    }
                }
                "inbound-rtp" -> {
                    val received = jsonNumber(obj, "packetsReceived")
                    jsonNumber(obj, "jitter")?.let { value ->
                        val weight = kotlin.math.max(1.0, received ?: 1.0)
                        inboundJitterWeightedMs += value * 1000.0 * weight
                        inboundJitterWeight += weight
                        foundMetric = true
                    }
                    jsonNumber(obj, "packetsLost")?.let { value ->
                        inboundPacketsLost += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                    received?.let { value ->
                        inboundPacketsReceived += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                    if (isMediaRtpStats(obj)) {
                        jsonNumber(obj, "bytesReceived")?.let { value ->
                            inboundMediaBytes = addNullable(inboundMediaBytes, value)
                            foundMetric = true
                        }
                    }
                }
                "remote-inbound-rtp" -> {
                    jsonNumber(obj, "roundTripTime")?.let { value ->
                        rttMs = maxNullable(rttMs, value * 1000.0)
                        foundMetric = true
                    }
                    val received = jsonNumber(obj, "packetsReceived")
                    jsonNumber(obj, "jitter")?.let { value ->
                        val weight = kotlin.math.max(1.0, received ?: 1.0)
                        remoteInboundJitterWeightedMs += value * 1000.0 * weight
                        remoteInboundJitterWeight += weight
                        foundMetric = true
                    }
                    jsonNumber(obj, "packetsLost")?.let { value ->
                        remoteInboundPacketsLost += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                    received?.let { value ->
                        remoteInboundPacketsReceived += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                    normalizeFractionLost(jsonNumber(obj, "fractionLost"))?.let { value ->
                        remoteInboundLossFraction =
                            if (remoteInboundLossFraction == null) {
                                value
                            } else {
                                kotlin.math.max(remoteInboundLossFraction ?: value, value)
                            }
                        foundMetric = true
                    }
                }
                "outbound-rtp" -> {
                    if (isMediaRtpStats(obj)) {
                        jsonNumber(obj, "bytesSent")?.let { value ->
                            outboundMediaBytes = addNullable(outboundMediaBytes, value)
                            foundMetric = true
                        }
                    }
                    if (statsMediaKind(obj) == "video" && obj.has("qualityLimitationReason")) {
                        outboundVideoQualityLimitationReason = selectQualityLimitationReason(
                            outboundVideoQualityLimitationReason,
                            obj.optString("qualityLimitationReason", ""),
                        )
                        foundMetric = true
                    }
                }
            }
        }

        candidatePairRttMs?.let { value ->
            rttMs = maxNullable(rttMs, value)
        }

        if (!foundMetric) return null
        val inboundJitterMs =
            if (inboundJitterWeight > 0.0) inboundJitterWeightedMs / inboundJitterWeight else null
        val remoteInboundJitterMs =
            if (remoteInboundJitterWeight > 0.0) remoteInboundJitterWeightedMs / remoteInboundJitterWeight else null
        return ConnectionStatsSample(
            rttMs = rttMs,
            inboundJitterMs = inboundJitterMs,
            inboundJitterWeight = inboundJitterWeight,
            inboundPacketsLost = inboundPacketsLost,
            inboundPacketsReceived = inboundPacketsReceived,
            remoteInboundJitterMs = remoteInboundJitterMs,
            remoteInboundJitterWeight = remoteInboundJitterWeight,
            remoteInboundPacketsLost = remoteInboundPacketsLost,
            remoteInboundPacketsReceived = remoteInboundPacketsReceived,
            remoteInboundLossFraction = remoteInboundLossFraction,
            availableOutgoingBitrate = availableOutgoingBitrate,
            availableIncomingBitrate = availableIncomingBitrate,
            outboundMediaBytes = outboundMediaBytes,
            inboundMediaBytes = inboundMediaBytes,
            outboundVideoQualityLimitationReason = outboundVideoQualityLimitationReason,
        )
    }

    private fun jsonNumber(obj: org.json.JSONObject, key: String): Double? {
        if (!obj.has(key)) return null
        val value = obj.optDouble(key, Double.NaN)
        return if (!value.isNaN() && !value.isInfinite()) value else null
    }

    private fun maxNullable(current: Double?, next: Double): Double {
        return if (current == null) next else kotlin.math.max(current, next)
    }

    private fun minPositiveNullable(current: Double?, next: Double?): Double? {
        if (next == null || next <= 0.0) return current
        if (current == null || current <= 0.0) return next
        return kotlin.math.min(current, next)
    }

    private fun addNullable(current: Double?, next: Double?): Double? {
        if (next == null) return current
        if (current == null) return next
        return current + next
    }

    private fun windowedBitrate(
        currentBytes: Double?,
        previousBytes: Double?,
        elapsedMs: Double,
    ): Double? {
        if (currentBytes == null || previousBytes == null || elapsedMs < 250.0) return null
        val deltaBytes = currentBytes - previousBytes
        if (deltaBytes < 0.0) return null
        return (deltaBytes * 8_000.0) / elapsedMs
    }

    private fun normalizeFractionLost(value: Double?): Double? {
        if (value == null || value < 0.0) return null
        if (value > 1.0 && value <= 255.0) return kotlin.math.min(value / 255.0, 1.0)
        return kotlin.math.min(value, 1.0)
    }

    private fun windowedPacketLoss(
        current: ConnectionLossSample,
        previous: ConnectionLossSample?,
    ): Double? {
        previous ?: return null
        val deltaLost = kotlin.math.max(0.0, current.packetsLost - previous.packetsLost)
        val deltaReceived = kotlin.math.max(0.0, current.packetsReceived - previous.packetsReceived)
        val deltaTotal = deltaLost + deltaReceived
        return if (deltaTotal > 0.0) deltaLost / deltaTotal else 0.0
    }

    private fun deriveConnectionQuality(
        rttMs: Double?,
        packetLoss: Double?,
        jitterMs: Double?,
    ): ConnectionQuality {
        if (rttMs == null && packetLoss == null && jitterMs == null) {
            return ConnectionQuality.unknown
        }
        if ((rttMs ?: 0.0) >= 850.0 ||
            (packetLoss ?: 0.0) >= 0.15 ||
            (jitterMs ?: 0.0) >= 120.0) {
            return ConnectionQuality.emergency
        }
        if ((rttMs ?: 0.0) >= 500.0 ||
            (packetLoss ?: 0.0) >= 0.08 ||
            (jitterMs ?: 0.0) >= 60.0) {
            return ConnectionQuality.poor
        }
        if ((rttMs ?: 0.0) >= 250.0 ||
            (packetLoss ?: 0.0) >= 0.05 ||
            (jitterMs ?: 0.0) >= 30.0) {
            return ConnectionQuality.fair
        }
        return ConnectionQuality.good
    }

    private fun deriveAvailableBitrateQuality(
        availableBitrate: Double?,
        mediaBitrate: Double?,
        fairBitrate: Double,
        poorBitrate: Double,
        emergencyBitrate: Double,
        encoderLimited: Boolean,
    ): ConnectionQuality {
        if (availableBitrate == null || availableBitrate <= 0.0 || availableBitrate > fairBitrate) {
            return ConnectionQuality.unknown
        }
        if (!isLowAvailableBitrate(availableBitrate, mediaBitrate, encoderLimited)) {
            return ConnectionQuality.unknown
        }
        if (availableBitrate <= emergencyBitrate) {
            return ConnectionQuality.emergency
        }
        if (availableBitrate <= poorBitrate) {
            return ConnectionQuality.poor
        }
        return ConnectionQuality.fair
    }

    private fun isLowAvailableBitrate(
        availableBitrate: Double,
        mediaBitrate: Double?,
        encoderLimited: Boolean,
    ): Boolean {
        if (encoderLimited) return true
        if (mediaBitrate == null || mediaBitrate <= 0.0) return false
        return mediaBitrate >= availableBitrate * availableBitrateSaturationRatio
    }

    private fun worstConnectionQuality(vararg qualities: ConnectionQuality): ConnectionQuality {
        var worst = ConnectionQuality.unknown
        for (quality in qualities) {
            if (connectionQualityRank(quality) > connectionQualityRank(worst)) {
                worst = quality
            }
        }
        return worst
    }

    private fun statsMediaKind(obj: JSONObject): String? {
        val kind = obj.optString("kind", "").takeIf { it.isNotBlank() }
            ?: obj.optString("mediaType", "").takeIf { it.isNotBlank() }
        return kind?.lowercase()
    }

    private fun isMediaRtpStats(obj: JSONObject): Boolean {
        return when (statsMediaKind(obj)) {
            "audio", "video" -> true
            else -> false
        }
    }

    private fun hasEncoderQualityLimitation(reason: String?): Boolean {
        val normalized = reason?.trim()?.lowercase() ?: return false
        return normalized.isNotEmpty() && normalized != "none"
    }

    private fun selectQualityLimitationReason(current: String?, next: String?): String? {
        if (next == null) return current
        if (current == null) return next
        return if (qualityLimitationRank(next) > qualityLimitationRank(current)) next else current
    }

    private fun qualityLimitationRank(reason: String?): Int {
        return when (reason?.trim()?.lowercase()) {
            "bandwidth" -> 3
            "cpu" -> 2
            "other" -> 1
            else -> 0
        }
    }

    // Reads audioLevel (0.0-1.0, RMS-derived) from local producer and remote
    // consumer WebRTC stats. The shared VM picks the loudest above a threshold.
    internal fun sampleAudioLevels(localUserId: String? = null): Dictionary<String, Double> {
        var levels: Dictionary<String, Double> = dictionaryOf()
        for ((_, info) in consumers) {
            if (info.kind != "audio" || info.type != ProducerType.webcam.rawValue) {
                continue
            }
            val statsJson = try {
                info.consumer.getStats()
            } catch (_: Throwable) {
                continue
            }
            val level = parseInboundAudioLevel(statsJson) ?: continue
            levels[info.userId] = level
        }
        val normalizedLocalUserId = localUserId?.trim()?.takeIf { it.isNotEmpty() }
        val localTrack = localAudioTrack
        val localProducer = audioProducer
        if (
            normalizedLocalUserId != null &&
            localAudioEnabled &&
            localTrack?.enabled() == true &&
            localProducer != null
        ) {
            val statsJson = try {
                localProducer.getStats()
            } catch (_: Throwable) {
                null
            }
            val level = statsJson?.let { parseAudioLevel(it) }
            if (level != null) {
                val existing = levels[normalizedLocalUserId] ?: 0.0
                levels[normalizedLocalUserId] = maxOf(existing, level)
            }
        }
        return levels.sref()
    }

    private fun parseInboundAudioLevel(statsJson: String): Double? {
        return parseAudioLevel(statsJson, requiredType = "inbound-rtp")
    }

    private fun parseAudioLevel(statsJson: String, requiredType: String? = null): Double? {
        return try {
            val array = org.json.JSONArray(statsJson)
            var best: Double? = null
            for (i in 0 until array.length()) {
                val obj = array.optJSONObject(i) ?: continue
                if (requiredType != null && obj.optString("type") != requiredType) {
                    continue
                }
                if (!obj.has("audioLevel")) {
                    continue
                }
                val value = obj.optDouble("audioLevel", 0.0)
                val currentBest = best
                if (currentBest == null || value > currentBest) {
                    best = value
                }
            }
            best
        } catch (_: Throwable) {
            null
        }
    }

    // Video freeze watchdog — mirrors iOS checkVideoFreezes (and the web one):
    // if framesDecoded stays flat while real media still flows (bytesReceived
    // climbs >= threshold) across 2 checks, the decoder is stuck on a stale
    // frame; request a keyframe (PLI) so it un-freezes. Invisible to track-mute.
    private val videoFreezeStats: MutableMap<String, Triple<Double, Double, Int>> =
        mutableMapOf()

    internal suspend fun checkVideoFreezes() {
        val minStallByteDelta = 8000.0
        val stallSamplesBeforePLI = 2
        val active = mutableSetOf<String>()
        for ((consumerId, info) in consumers) {
            if (info.kind != "video") continue
            active.add(consumerId)
            val statsJson = try {
                info.consumer.getStats()
            } catch (_: Throwable) {
                continue
            }
            val sample = parseInboundVideoDecode(statsJson) ?: continue
            val frames = sample.first
            val bytes = sample.second
            val prev = videoFreezeStats[consumerId]
            var stalls = 0
            if (prev != null) {
                val stuck = frames == prev.first &&
                    (bytes - prev.second) >= minStallByteDelta
                stalls = if (stuck) prev.third + 1 else 0
            }
            if (stalls >= stallSamplesBeforePLI) {
                // Still frozen — request a keyframe. Do NOT reset the stall
                // counter (mirrors the Swift fix): if this PLI is lost on a
                // congested link, the next ~2s poll still sees frames flat and
                // re-requests, instead of waiting out two fresh stall windows.
                // Resets to 0 naturally once frames advance.
                try {
                    socketManager?.resumeConsumer(consumerId, true)
                } catch (_: Throwable) {
                }
            }
            videoFreezeStats[consumerId] = Triple(frames, bytes, stalls)
        }
        for (key in videoFreezeStats.keys.toList()) {
            if (!active.contains(key)) {
                videoFreezeStats.remove(key)
                remoteConsumerPreferenceSignatures.remove(key)
                remoteConsumerLayerPreferenceUnsupportedIds.remove(key)
                remoteConsumerPreferenceInFlightIds.remove(key)
            }
        }
    }

    internal suspend fun refreshVideoDecoders(userId: String? = null) {
        val socket = socketManager ?: return
        val targetUserId = userId?.trim()?.takeIf { it.isNotEmpty() }
        for ((consumerId, info) in consumers) {
            if (info.kind != "video") continue
            if (
                targetUserId != null &&
                info.userId != targetUserId &&
                info.trackKey != targetUserId
            ) {
                continue
            }
            videoFreezeStats.remove(consumerId)
            try {
                socket.resumeConsumer(consumerId, true)
            } catch (_: Throwable) {
            }
        }
    }

    private fun parseInboundVideoDecode(statsJson: String): Pair<Double, Double>? {
        val array = try {
            org.json.JSONArray(statsJson)
        } catch (_: Throwable) {
            return null
        }
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            if (obj.optString("type") != "inbound-rtp") continue
            val kind = if (obj.has("kind")) obj.optString("kind") else obj.optString("mediaType")
            if (kind != "video") continue
            if (!obj.has("framesDecoded") || !obj.has("bytesReceived")) continue
            val frames = obj.optDouble("framesDecoded", -1.0)
            val bytes = obj.optDouble("bytesReceived", -1.0)
            if (frames < 0 || bytes < 0) continue
            return Pair(frames, bytes)
        }
        return null
    }

    override fun onConnect(transport: Transport, dtlsParameters: String) {
        val socket = socketManager ?: return
        runBlocking {
            try {
                val params = decodeJSONString<DtlsParameters>(dtlsParameters) ?: return@runBlocking
                if (transport.id == sendTransportId) {
                    socket.connectProducerTransport(transport.id, params)
                } else {
                    socket.connectConsumerTransport(transport.id, params)
                }
            } catch (_: Throwable) {
            }
        }
    }

    override fun onConnectionStateChange(transport: Transport, connectionState: String) {
        val stateName = connectionState.lowercase()
        transportConnectionStates[transport.id] = stateName
        val transportKind = when (transport.id) {
            sendTransportId -> "producer"
            receiveTransportId -> "consumer"
            else -> return
        }
        onTransportConnectionStateChanged?.invoke(transportKind, stateName)
    }

    override fun onProduce(transport: Transport, kind: String, rtpParameters: String, appData: String): String {
        val socket = socketManager ?: return ""
        return runBlocking {
            try {
                // rtpParameters arrives as raw JSON from mediasoup; forward it
                // verbatim instead of decoding into RtpParameters and re-encoding
                // (Skip's JSONEncoder can't encode the AnyCodable codec params).
                val appDataPayload = decodeJSONString<ProducerAppData>(appData, allowFailure = true)
                val type = ProducerType(rawValue = appDataPayload?.type ?: "webcam") ?: ProducerType.webcam
                socket.produceRaw(
                    transportId = transport.id,
                    kind = kind,
                    rtpParametersJson = rtpParameters,
                    type = type,
                    paused = appDataPayload?.paused ?: false
                )
            } catch (t: Throwable) {
                debugLog("[WebRTC] Produce failed: ${t}")
                android.util.Log.e("ConclaveWebRTC", "Produce failed", t)
                ""
            }
        }
    }

    override fun onProduceData(
        transport: Transport,
        sctpParameters: String,
        label: String,
        dataProtocol: String,
        appData: String
    ): String {
        return ""
    }

    override fun onTransportClose(producer: Producer) {
        if (producer.id == audioProducer?.id) {
            audioProducer = null
            audioProducerBandwidthQuality = ConnectionQuality.unknown
            localAudioEnabled = false
            onLocalAudioEnabledChanged?.invoke(false)
        } else if (producer.id == videoProducer?.id) {
            videoProducer = null
            videoProducerBandwidthQuality = ConnectionQuality.unknown
            videoProducerBandwidthSignature = null
            localVideoEnabled = false
            onLocalVideoEnabledChanged?.invoke(false)
        } else if (producer.id == screenProducer?.id) {
            screenProducer = null
            screenProducerBandwidthQuality = ConnectionQuality.unknown
        }
    }

    override fun onTransportClose(consumer: Consumer) {
        val entry = consumers.entries.firstOrNull { it.value.consumer.id == consumer.id } ?: return
        consumers.remove(entry.key)
        videoFreezeStats.remove(entry.key)
        remoteConsumerPreferenceSignatures.remove(entry.key)
        remoteConsumerLayerPreferenceUnsupportedIds.remove(entry.key)
        remoteConsumerPreferenceInFlightIds.remove(entry.key)
        if (entry.value.kind == "video") {
            val trackKey = if (entry.value.trackKey.isEmpty()) entry.value.userId else entry.value.trackKey
            if (trackKey.isNotEmpty()) {
                remoteVideoTracks.removeValue(forKey = trackKey)
            }
        }
    }

    private fun ensurePeerConnectionFactory(context: Context) {
        if (peerConnectionFactory != null) return

        val options = PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()
        PeerConnectionFactory.initialize(options)

        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        peerConnectionFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    private fun createCameraCapturer(context: Context): VideoCapturer? {
        val enumerator = if (Camera2Enumerator.isSupported(context)) {
            Camera2Enumerator(context)
        } else {
            Camera1Enumerator(true)
        }

        val deviceNames = enumerator.deviceNames
        val frontName = deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
        val backName = deviceNames.firstOrNull { enumerator.isBackFacing(it) }

        return when {
            frontName != null -> enumerator.createCapturer(frontName, null)
            backName != null -> enumerator.createCapturer(backName, null)
            else -> null
        }
    }

    private fun resolvePeerConnectionOptions(): MediasoupPeerConnection.Options? {
        val raw = runtimeIceServersJSON ?: return null
        val iceServers = parseIceServers(raw)
        if (iceServers.isEmpty()) return null

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers)
        val options = MediasoupPeerConnection.Options()
        options.setRTCConfig(rtcConfig)
        return options
    }

    private fun parseIceServers(raw: String): List<PeerConnection.IceServer> {
        val array = try {
            JSONArray(raw)
        } catch (_: Throwable) {
            return emptyList()
        }
        val servers = mutableListOf<PeerConnection.IceServer>()

        for (index in 0 until array.length()) {
            val obj = array.optJSONObject(index) ?: continue
            val urlsValue = obj.opt("urls")
            val urls = when (urlsValue) {
                is JSONArray -> {
                    val out = mutableListOf<String>()
                    for (urlIndex in 0 until urlsValue.length()) {
                        val url = urlsValue.optString(urlIndex).trim()
                        if (url.isNotEmpty()) out.add(url)
                    }
                    out
                }
                is String -> listOf(urlsValue.trim()).filter { it.isNotEmpty() }
                else -> emptyList()
            }
            if (urls.isEmpty()) continue

            val builder = PeerConnection.IceServer.builder(urls)
            val username = obj.optString("username", "").trim()
            val credential = obj.optString("credential", "").trim()
            if (username.isNotEmpty()) builder.setUsername(username)
            if (credential.isNotEmpty()) builder.setPassword(credential)
            servers.add(builder.createIceServer())
        }

        return servers
    }

    private fun encodeJSONString(value: Any): String {
        val data = JSONEncoder().encode(value)
        return data.platformValue.toString(Charsets.UTF_8)
    }

    private inline fun <reified T : Decodable> decodeJSONString(raw: String, allowFailure: Boolean = false): T? {
        val data = Data(platformValue = raw.toByteArray(Charsets.UTF_8))
        return try {
            JSONDecoder().decode(T::class, from = data)
        } catch (error: Throwable) {
            if (allowFailure) null else throw error
        }
    }
}
