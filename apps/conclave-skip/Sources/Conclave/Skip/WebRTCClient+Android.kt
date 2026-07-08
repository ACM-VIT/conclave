package conclave.module

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import org.webrtc.CameraVideoCapturer
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
import org.webrtc.audio.JavaAudioDeviceModule
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
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

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
    internal var onCallAudioRouteChanged: (() -> Unit)? = null
    internal var onLocalAudioProducerLost: (() -> Unit)? = null
    internal var onLocalVideoProducerLost: (() -> Unit)? = null

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
    // tears it down - lets the rejoin path detect a still-live prior session.
    internal val isConfigured: Boolean get() = device != null
    private var sendTransport: SendTransport? = null
    private var receiveTransport: RecvTransport? = null
    private var sendTransportId: String? = null
    private var receiveTransportId: String? = null
    private var runtimeIceServersJSON: String? = null
    private val transportConnectionStates: MutableMap<String, String> = mutableMapOf()
    private val mediaStackLock = Any()
    @Volatile private var mediaStackPrewarmStarted = false
    @Volatile private var mediasoupInitialized = false

    private var audioProducer: Producer? = null
    private var videoProducer: Producer? = null
    private var screenProducer: Producer? = null
    internal val hasLocalAudioProducer: Boolean
        get() = hasUsableProducer(audioProducer) &&
            sendTransport?.isClosed == false &&
            localAudioTrack?.state() == MediaStreamTrack.State.LIVE
    internal val isLocalAudioPublishingHealthy: Boolean
        get() = hasLocalAudioProducer &&
            localAudioEnabled &&
            localAudioTargetEnabled &&
            localAudioTrack?.enabled() == true &&
            localAudioTrack?.state() == MediaStreamTrack.State.LIVE
    internal val hasLocalVideoProducer: Boolean
        get() = hasUsableProducer(videoProducer) &&
            sendTransport?.isClosed == false &&
            localVideoTrack != null &&
            videoCapturer != null &&
            videoSource != null

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
    private val mainHandler = Handler(Looper.getMainLooper())
    private var remoteConsumerPreferenceRetryJob: Job? = null
    private var remoteVideoReceiveEnabled = true
    private var serverRtpCapabilities: RtpCapabilities? = null

    companion object {
        private const val MAX_REMOTE_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE = 8
        private const val REMOTE_CONSUMER_PREFERENCE_EMIT_SPACING_MS = 75L
        private const val REMOTE_CONSUMER_PREFERENCE_RETRY_DELAY_MS = 1_000L
        private const val PRE_JOIN_CAMERA_RELEASE_SETTLE_MS = 350L
        private const val WEBRTC_NETWORK_PRIORITY_VERY_LOW = 0
        private const val WEBRTC_NETWORK_PRIORITY_HIGH = 3
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

    private fun initialScreenConsumerPreference(
        connectionQuality: ConnectionQuality,
    ): InitialConsumerPreference {
        val temporalLayer = when (connectionQuality) {
            ConnectionQuality.emergency -> 1
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
        initialReceiveConnectionQuality: ConnectionQuality,
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
            return initialScreenConsumerPreference(
                connectionQuality = initialReceiveConnectionQuality,
            )
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
                receiveVideo = remoteVideoReceiveEnabled,
            )
        }
    }

    internal fun hasBrokenTransport(): Boolean {
        return transportConnectionStates.values.any { state ->
            state == "failed" || state == "disconnected" || state == "closed"
        }
    }

    private fun ensureCurrentConfiguration(generation: Long) {
        if (generation != configurationGeneration) {
            throw ErrorException("WebRTC session was replaced")
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
            removeConsumer(consumerId, info, closeConsumer = true)
        }
    }

    internal fun closeConsumers(userIdPrefix: String) {
        val prefix = userIdPrefix.trim()
        if (prefix.isEmpty()) return

        val matchingConsumers = consumers
            .filterValues { it.userId.startsWith(prefix) || it.trackKey.startsWith(prefix) }

        for ((consumerId, info) in matchingConsumers) {
            removeConsumer(consumerId, info, closeConsumer = true)
        }
    }

    internal fun applyConsumerTelemetry(notification: ConsumerTelemetryNotification) {
        val info = consumers[notification.consumerId] ?: return
        if (info.producerId != notification.producerId) return

        if (notification.event == "closed") {
            removeConsumer(
                notification.consumerId,
                info,
                closeConsumer = true,
                notifyServer = false
            )
            return
        }

        remoteConsumerPreferenceSignatures[notification.consumerId] = RemoteConsumerPreference(
            spatialLayer = notification.preferredLayers?.spatialLayer,
            temporalLayer = notification.preferredLayers?.temporalLayer,
            priority = notification.priority,
            paused = notification.paused,
        ).signature

        if (notification.paused || notification.producerPaused) {
            videoFreezeStats.remove(notification.consumerId)
        }
    }

    private fun removeConsumer(
        consumerId: String,
        info: ConsumerInfo,
        closeConsumer: Boolean,
        notifyServer: Boolean = true
    ) {
        if (closeConsumer) {
            info.consumer.close()
            if (notifyServer) {
                socketManager?.closeConsumer(consumerId)
            }
        }
        consumers.remove(consumerId)
        videoFreezeStats.remove(consumerId)
        remoteConsumerPreferenceSignatures.remove(consumerId)
        remoteConsumerLayerPreferenceUnsupportedIds.remove(consumerId)
        remoteConsumerPreferenceInFlightIds.remove(consumerId)

        val key = if (info.trackKey.isEmpty()) info.userId else info.trackKey
        if (info.kind == "video" && key.isNotEmpty()) {
            remoteVideoTracks.removeValue(forKey = key)
        }
    }

    internal suspend fun applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: skip.lib.Set<String>,
        visibleUserIds: skip.lib.Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        receiveVideo: Boolean = true,
    ) {
        remoteVideoReceiveEnabled = receiveVideo
        val socket = socketManager ?: return

        val shouldReceiveVideo = receiveVideo
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
                receiveVideo = shouldReceiveVideo,
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
        receiveVideo: Boolean,
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

        if (!receiveVideo) {
            return RemoteConsumerPreference(
                spatialLayer = 0,
                temporalLayer = 0,
                priority = 8,
                paused = true,
            )
        }

        if (info.type == ProducerType.screen.rawValue) {
            val temporalLayer = when (connectionQuality) {
                ConnectionQuality.emergency -> 1
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
    // singleton - never released here.
    private val eglBase: EglBase = VideoRendererShared.eglBase
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoCapturer: VideoCapturer? = null
    private var isWebcamCaptureActive = false
    internal val currentCameraFacing: LocalCameraFacing
        get() = activeCameraFacing
    private var activeCameraFacing: LocalCameraFacing = LocalCameraFacing.front
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var localAudioTrackSequence = 0
    private var localVideoTrackSequence = 0
    private var screenVideoTrackSequence = 0
    private var currentVideoQuality: VideoQuality = VideoQuality.standard
    private var currentLocalBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var audioProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var videoProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var videoProducerBandwidthSignature: String? = null
    private var screenProducerBandwidthQuality: ConnectionQuality = ConnectionQuality.unknown
    private var selectedAudioOutputDeviceId: String? = null
    private var selectedAudioInputDeviceId: String? = null
    private var audioDeviceCallback: AudioDeviceCallback? = null
    private var communicationDeviceChangedListener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isCallAudioModeActive = false
    private var hasCallAudioFocus = false
    private var localAudioTargetEnabled = false
    private var bluetoothConnectAutoRequestAttempted = false
    private var bluetoothConnectPermissionRequestToken: PermissionHelper.PermissionRequestToken? = null
    private var audioStartOrEnableInFlight = false
    private var audioRouteReapplyScheduled = false
    private var delayedAudioRouteReapplyRunnable: Runnable? = null
    private var lastAudioRouteReapplyAtMs = 0L
    private var audioRouteChangeNotificationScheduled = false
    private var audioCaptureRestartScheduled = false
    private var audioCaptureReassertionGeneration = 0
    private var lastAppliedAudioRouteSignature: String? = null
    private var audioRouteMismatchSignature: String? = null
    private var audioRouteMismatchReapplyAttempts = 0
    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasCallAudioFocus = true
                if (isCallAudioModeActive) {
                    scheduleCallAudioRouteReapply()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                hasCallAudioFocus = false
            }
        }
    }
    private var audioBandwidthRefreshInFlight = false
    private var audioProducerRouteRecoveryInFlight = false
    private var videoBandwidthRefreshInFlight = false
    private var screenBandwidthRefreshInFlight = false
    private var lastAppliedLocalBandwidthSignature: String? = null
    private val screenShareTemporalLayerCount = 3
    private val audioRouteRecoveryScope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())

    internal fun prewarmMediaStack() {
        if (mediaStackPrewarmStarted || peerConnectionFactory != null) return
        mediaStackPrewarmStarted = true
        Thread {
            val startedAt = System.nanoTime()
            try {
                ensureAndroidMediaStack(ProcessInfo.processInfo.androidContext)
                NativePerformanceDiagnostics.timingAlways(
                    "webrtc_media_stack_prewarm",
                    startedAt,
                    "configured=${peerConnectionFactory != null}"
                )
                NativePerformanceDiagnostics.memory("after_webrtc_prewarm")
            } catch (error: Throwable) {
                debugLog("[WebRTC] Media stack prewarm failed: ${error}")
            }
        }.apply {
            name = "ConclaveWebRTCPrewarm"
            isDaemon = true
            start()
        }
    }

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
        val maxWidth: Int,
        val maxHeight: Int,
    )

    private data class ScreenShareCaptureProfile(
        val width: Int,
        val height: Int,
        val maxFramerate: Int,
    )

    // Screen-share capture chain (MediaProjection -> ScreenCapturerAndroid).
    private var screenCapturer: VideoCapturer? = null
    private var screenVideoSource: VideoSource? = null
    private var screenSurfaceTextureHelper: SurfaceTextureHelper? = null
    private var screenVideoTrack: VideoTrack? = null

    internal fun configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) {
        val startedAt = System.nanoTime()
        configurationGeneration += 1
        this.socketManager = socketManager
        this.serverRtpCapabilities = rtpCapabilities
        this.runtimeIceServersJSON = iceServersJSON?.trim()?.takeIf { it.isNotEmpty() }

        val context = ProcessInfo.processInfo.androidContext
        try {
            ensureAndroidMediaStack(context)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to initialize Android media stack: ${error}")
            this.device = null
            return
        }
        NativePerformanceDiagnostics.timingAlways("webrtc_configure_media_stack", startedAt)

        this.device = null
        // mediasoup Device.load() takes the router rtpCapabilities as a JSON
        // string. We use the verbatim JSON the server sent in the joinRoom ack
        // (captured by SocketIOManager) rather than re-encoding the decoded
        // Codable struct - Skip's JSONEncoder crashes on the [String: String]
        // codec `parameters` map ("Tuple2 cannot be cast to Encodable"). The
        // raw JSON matches what the iOS path feeds load (numeric `apt`/
        // `packetization-mode`, string `profile-level-id`) - keep it verbatim.
        val capabilities = socketManager.routerRtpCapabilitiesJson
        if (capabilities.isNullOrBlank()) {
            debugLog("[WebRTC] Router RTP capabilities JSON unavailable")
            return
        }

        val device = Device()
        try {
            val loadStartedAt = System.nanoTime()
            device.load(capabilities, null)
            this.device = device
            NativePerformanceDiagnostics.timingAlways("webrtc_device_load", loadStartedAt)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to load device capabilities: ${error}")
            this.device = null
        }
    }

    internal suspend fun createTransports() {
        val startedAt = System.nanoTime()
        createSendTransportIfNeeded()
        createReceiveTransport()
        NativePerformanceDiagnostics.timingAlways("webrtc_create_transports_total", startedAt)
    }

    internal suspend fun createReceiveTransport() {
        createReceiveTransportIfNeeded()
    }

    private suspend fun createSendTransportIfNeeded() {
        val existing = sendTransport
        if (existing != null && !existing.isClosed && sendTransportId != null) {
            return
        }

        val startedAt = System.nanoTime()
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val device = device ?: throw ErrorException("Device not configured")
        val generation = configurationGeneration

        val producerRequestStartedAt = System.nanoTime()
        val producerTransportParams = socket.createProducerTransport()
        NativePerformanceDiagnostics.timingAlways("webrtc_create_producer_transport_ack", producerRequestStartedAt)
        if (generation != configurationGeneration) {
            throw ErrorException("WebRTC session was replaced")
        }

        val localCreateStartedAt = System.nanoTime()
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

        if (generation != configurationGeneration) {
            nextSendTransport.close()
            throw ErrorException("WebRTC session was replaced")
        }

        sendTransport?.close()
        sendTransportId = producerTransportParams.id
        sendTransport = nextSendTransport
        NativePerformanceDiagnostics.timingAlways("webrtc_create_send_transport_local", localCreateStartedAt)
        NativePerformanceDiagnostics.timingAlways("webrtc_create_send_transport_total", startedAt)
    }

    private suspend fun createReceiveTransportIfNeeded() {
        val existing = receiveTransport
        if (existing != null && !existing.isClosed && receiveTransportId != null) {
            return
        }

        val startedAt = System.nanoTime()
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val device = device ?: throw ErrorException("Device not configured")
        val generation = configurationGeneration

        val consumerRequestStartedAt = System.nanoTime()
        val consumerTransportParams = socket.createConsumerTransport()
        NativePerformanceDiagnostics.timingAlways("webrtc_create_consumer_transport_ack", consumerRequestStartedAt)
        if (generation != configurationGeneration) {
            throw ErrorException("WebRTC session was replaced")
        }

        val localCreateStartedAt = System.nanoTime()
        val peerConnectionOptions = resolvePeerConnectionOptions()
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
            nextReceiveTransport.close()
            throw ErrorException("WebRTC session was replaced")
        }

        receiveTransport?.close()
        receiveTransportId = consumerTransportParams.id
        receiveTransport = nextReceiveTransport
        NativePerformanceDiagnostics.timingAlways("webrtc_create_receive_transport_local", localCreateStartedAt)
        NativePerformanceDiagnostics.timingAlways("webrtc_create_receive_transport_total", startedAt)
        NativePerformanceDiagnostics.memory("after_webrtc_create_transports")
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
        createSendTransportIfNeeded()
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        val generation = configurationGeneration
        if (hasLocalAudioProducer) {
            setAudioEnabled(true)
            return
        }
        if (audioProducer != null || localAudioTrack != null || audioSource != null) {
            audioProducer?.close()
            audioProducer = null
            audioProducerBandwidthQuality = ConnectionQuality.unknown
            audioCaptureReassertionGeneration += 1
            clearLocalAudioCapture()
            localAudioEnabled = false
            localAudioTargetEnabled = false
        }

        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        if (!ensureRecordAudioPermission()) {
            throw ErrorException("Microphone permission not granted")
        }
        ensureCurrentConfiguration(generation)
        localAudioTargetEnabled = true
        audioStartOrEnableInFlight = true
        var pendingProducer: Producer? = null
        try {
            configureCallAudioMode(unmuted = true)
            ensureCurrentConfiguration(generation)

            if (audioSource == null) {
                audioSource = peerConnectionFactory?.createAudioSource(microphoneAudioConstraints())
            }

            localAudioTrack = peerConnectionFactory?.createAudioTrack(nextLocalAudioTrackId(), audioSource)
            val audioTrack = localAudioTrack ?: throw ErrorException("Audio track unavailable")
            forceUnmuteMicrophoneCapture()
            audioTrack.setEnabled(true)

            val producer = produceMicrophoneAudio(sendTransport, audioTrack)
            pendingProducer = producer
            producer.resume()

            audioProducer = producer
            audioProducerBandwidthQuality = currentLocalBandwidthQuality
            localAudioEnabled = true
            localAudioTargetEnabled = true
            forceUnmuteMicrophoneCapture()
            audioManager()?.let { manager ->
                applyLocalAudioCaptureState(manager, true)
                scheduleLocalAudioCaptureReassertion(true)
            }
            markMicrophoneProducerUnmuted(producer.id, "audio start")
            onLocalAudioEnabledChanged?.invoke(true)
        } catch (t: Throwable) {
            pendingProducer?.close()
            if (pendingProducer != null && audioProducer?.id == pendingProducer.id) {
                audioProducer = null
            }
            clearLocalAudioCapture()
            audioDeviceModule?.setMicrophoneMute(true)
            audioProducerBandwidthQuality = ConnectionQuality.unknown
            localAudioEnabled = false
            localAudioTargetEnabled = false
            throw t
        } finally {
            audioStartOrEnableInFlight = false
        }
    }

    internal suspend fun startProducingVideo() {
        createSendTransportIfNeeded()
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        val generation = configurationGeneration
        if (hasLocalVideoProducer) {
            setVideoEnabled(true)
            return
        }
        if (
            videoProducer != null ||
            localVideoTrack != null ||
            localVideoTrackWrapper != null ||
            videoSource != null
        ) {
            clearLocalWebcamCaptureState(notifyLocalState = false)
        }
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        // Without the CAMERA runtime permission, WebRTC's Camera2Capturer throws a
        // SecurityException on its async capture thread and CRASHES the process
        // (a try/catch around startCapture can't catch that thread). Request the
        // permission before capture starts and bail with a catchable error on denial.
        if (!ensureCameraPermission()) {
            throw ErrorException("Camera permission not granted")
        }
        ensureCurrentConfiguration(generation)

        var pendingProducer: Producer? = null
        try {
            releasePreJoinCameraPreview()

            if (videoCapturer == null) {
                videoCapturer = createCameraCapturer(ProcessInfo.processInfo.androidContext)
            }

            if (surfaceTextureHelper == null) {
                surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
            }

            val capturer = videoCapturer ?: throw ErrorException("No camera capturer")
            val textureHelper = surfaceTextureHelper ?: throw ErrorException("Camera texture helper unavailable")
            videoSource = peerConnectionFactory?.createVideoSource(false)
            val source = videoSource ?: throw ErrorException("Video source unavailable")
            capturer.initialize(textureHelper, ProcessInfo.processInfo.androidContext, source.capturerObserver)
            startWebcamCapture(capturer, "start")

            localVideoTrack = peerConnectionFactory?.createVideoTrack(nextLocalVideoTrackId(), source)
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
            clearLocalWebcamCaptureState(notifyLocalState = false)
            throw t
        }
    }

    /// Mirrors startProducingVideo but captures the device screen via
    /// MediaProjection. The permission result Intent was stored by
    /// ScreenCaptureManager from the consent dialog; ScreenCapturerAndroid mints
    /// its own MediaProjection from it (the foreground service must already be
    /// live with type mediaProjection - the VM awaits requestCapture() first).
    internal suspend fun startScreenSharing() {
        createSendTransportIfNeeded()
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        val context = ProcessInfo.processInfo.androidContext
        ensurePeerConnectionFactory(context)

        // The consent Intent is single-use on API 34+ (one Intent -> one
        // MediaProjection -> one createVirtualDisplay). ScreenCapturerAndroid
        // calls getMediaProjection(RESULT_OK, data) + createVirtualDisplay()
        // synchronously inside startCapture(); both are gated by the OS on the
        // mediaProjection-type FGS already being foregrounded - which the VM
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
            val capture = screenShareCaptureProfile(
                metrics.widthPixels,
                metrics.heightPixels,
                currentLocalBandwidthQuality,
            )
            // getMediaProjection() + createVirtualDisplay() happen here. If the
            // typed FGS isn't live, or the consent token was already consumed,
            // this throws SecurityException. Tear down the half-built capture
            // chain so a retry starts clean (no leaked SurfaceTextureHelper /
            // capturer) and rethrow for the VM's catch to surface the error.
            capturer.startCapture(
                capture.width,
                capture.height,
                capture.maxFramerate,
            )

            val track = peerConnectionFactory?.createVideoTrack(nextScreenVideoTrackId(), source)
                ?: throw ErrorException("Screen track unavailable")
            track.setEnabled(true)
            screenVideoTrack = track

            val appData = encodeJSONString(ProducerAppData(type = ProducerType.screen.rawValue, paused = false))
            val preferredCodec = preferredVideoCodecJson()
            val producer = requireRegisteredProducer(
                sendTransport.produce(
                    this,
                    track as MediaStreamTrack,
                    screenShareEncodings(currentLocalBandwidthQuality),
                    null,
                    preferredCodec,
                    appData,
                ),
                "screen"
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
        preferHighWebcamLayer: Boolean = false,
        initialReceiveConnectionQuality: ConnectionQuality = ConnectionQuality.unknown,
    ) {
        createReceiveTransportIfNeeded()
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
            initialReceiveConnectionQuality = initialReceiveConnectionQuality,
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
            val ids = consumers
                .filterValues { consumerMatchesUser(it, userId) }
                .keys
                .toList()
            ids.forEach { id ->
                val info = consumers[id]
                if (info != null) {
                    removeConsumer(id, info, closeConsumer = true)
                }
            }
        } else {
            val entry = consumers.entries.firstOrNull { it.value.producerId == producerId }
            if (entry != null) {
                removeConsumer(entry.key, entry.value, closeConsumer = true)
            }
        }

        if (producerId.isEmpty() && userId.isNotEmpty()) {
            remoteVideoTracks.keys
                .filter { trackKeyMatchesUser(it, userId) }
                .toList()
                .forEach { remoteVideoTracks.removeValue(forKey = it) }
        }
    }

    private fun consumerMatchesUser(info: ConsumerInfo, userId: String): Boolean {
        return trackKeyMatchesUser(info.userId, userId) ||
            trackKeyMatchesUser(info.trackKey, userId)
    }

    private fun trackKeyMatchesUser(trackKey: String, userId: String): Boolean {
        val normalizedTarget = userId.trim()
        val normalizedTrackKey = trackKey.trim()
        if (normalizedTarget.isEmpty() || normalizedTrackKey.isEmpty()) return false
        if (normalizedTarget == normalizedTrackKey) return true

        val screenSuffix = "-${ProducerType.screen.rawValue}"
        val targetIdentity = if (normalizedTarget.endsWith(screenSuffix)) {
            normalizedTarget.dropLast(screenSuffix.length)
        } else {
            normalizedTarget
        }
        val trackIdentity = if (normalizedTrackKey.endsWith(screenSuffix)) {
            normalizedTrackKey.dropLast(screenSuffix.length)
        } else {
            normalizedTrackKey
        }
        if (targetIdentity == trackIdentity) return true

        val targetKey = stableRemoteTrackUserKey(targetIdentity)
        val trackUserKey = stableRemoteTrackUserKey(trackIdentity)
        if (targetKey.isEmpty() || targetKey != trackUserKey) return false
        val targetHasSessionSuffix = targetIdentity.contains("#")
        val trackHasSessionSuffix = trackIdentity.contains("#")
        return !targetHasSessionSuffix || !trackHasSessionSuffix
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
        val generation = configurationGeneration
        val previous = localAudioEnabled
        localAudioTargetEnabled = enabled

        try {
            if (enabled) {
                audioStartOrEnableInFlight = true
                if (!ensureRecordAudioPermission()) {
                    throw ErrorException("Microphone permission not granted")
                }
                ensureCurrentConfiguration(generation)
                configureCallAudioMode(unmuted = true)
                forceUnmuteMicrophoneCapture()
                producer.resume()
            } else {
                producer.pause()
                audioDeviceModule?.setMicrophoneMute(true)
            }

            socket.toggleMute(producer.id, paused = !enabled)
            localAudioTrack?.setEnabled(enabled)
            localAudioEnabled = enabled
            localAudioTargetEnabled = enabled
            if (enabled) {
                audioManager()?.let { manager ->
                    applyLocalAudioCaptureState(manager, true)
                    scheduleLocalAudioCaptureReassertion(true)
                }
            }
            onLocalAudioEnabledChanged?.invoke(enabled)
        } catch (error: Throwable) {
            if (generation != configurationGeneration) {
                throw error
            }
            if (previous) {
                localAudioTargetEnabled = true
                producer.resume()
                localAudioTrack?.setEnabled(true)
                forceUnmuteMicrophoneCapture()
                configureCallAudioMode(unmuted = true)
            } else {
                localAudioTargetEnabled = false
                producer.pause()
                audioDeviceModule?.setMicrophoneMute(true)
            }
            localAudioTrack?.setEnabled(previous)
            localAudioEnabled = previous
            localAudioTargetEnabled = previous
            onLocalAudioEnabledChanged?.invoke(previous)
            debugLog("[WebRTC] Failed to toggle audio: ${error}")
            throw error
        } finally {
            if (enabled) {
                audioStartOrEnableInFlight = false
            }
        }
    }

    internal suspend fun reassertLocalAudioProducerUnmuted() {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val producer = audioProducer ?: throw ErrorException("Audio producer not ready")
        if (!hasLocalAudioProducer || !localAudioEnabled) return

        localAudioTargetEnabled = true
        configureCallAudioMode(unmuted = true)
        forceUnmuteMicrophoneCapture()
        localAudioTrack?.setEnabled(true)
        producer.resume()
        socket.toggleMute(producer.id, paused = false)
        audioManager()?.let { manager ->
            applyLocalAudioCaptureState(manager, true)
            scheduleLocalAudioCaptureReassertion(true)
        }
    }

    internal suspend fun setVideoEnabled(enabled: Boolean) {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val producer = videoProducer ?: throw ErrorException("Video producer not ready")
        val generation = configurationGeneration
        val previous = localVideoEnabled

        try {
            if (enabled) {
                if (!ensureCameraPermission()) {
                    throw ErrorException("Camera permission not granted")
                }
                ensureCurrentConfiguration(generation)
                releasePreJoinCameraPreview()
                if (
                    localVideoTrack == null ||
                    localVideoTrackWrapper == null ||
                    videoSource == null ||
                    videoCapturer == null
                ) {
                    throw ErrorException("Video track unavailable")
                }
                if (!localVideoEnabled) {
                    startWebcamCapture(videoCapturer, "restart")
                }
                producer.resume()
            } else {
                producer.pause()
            }

            socket.toggleCamera(producer.id, paused = !enabled)
            localVideoTrack?.setEnabled(enabled)
            localVideoEnabled = enabled
            localVideoTrackWrapper?.isEnabled = enabled

            if (!enabled) {
                stopWebcamCapture()
            }

            onLocalVideoEnabledChanged?.invoke(enabled)
        } catch (error: Throwable) {
            try {
                if (previous) {
                    producer.resume()
                } else {
                    producer.pause()
                }
            } catch (rollbackError: Throwable) {
                debugLog("[WebRTC] Failed to roll back video producer state after toggle failure: ${rollbackError}")
            }
            if (!previous) {
                stopWebcamCapture()
            }
            localVideoTrack?.setEnabled(previous)
            localVideoTrackWrapper?.isEnabled = previous
            localVideoEnabled = previous
            onLocalVideoEnabledChanged?.invoke(previous)
            debugLog("[WebRTC] Failed to toggle video: ${error}")
            throw error
        }
    }

    internal suspend fun closeLocalAudioProducer() {
        val socket = socketManager
        val producerId = audioProducer?.id ?: return

        closeLocalMedia(
            kind = "audio",
            type = ProducerType.webcam.rawValue,
            producerId = producerId
        )

        try {
            socket?.closeProducer(producerId)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to notify SFU of closed audio producer: ${error}")
        }
    }

    internal suspend fun closeLocalVideoProducer() {
        val socket = socketManager
        val producerId = videoProducer?.id
        if (producerId == null) {
            clearLocalWebcamCaptureState()
            return
        }

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
            clearLocalAudioCapture()
            audioDeviceModule?.setMicrophoneMute(true)
            localAudioEnabled = false
            localAudioTargetEnabled = false
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
            localVideoTrackWrapper?.setTrack(null)
            localVideoTrackWrapper = null
            localVideoTrack = null
            stopWebcamCapture()
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

    private fun clearLocalWebcamCaptureState(notifyLocalState: Boolean = true) {
        videoProducer?.close()
        videoProducer = null
        videoProducerBandwidthQuality = ConnectionQuality.unknown
        videoProducerBandwidthSignature = null
        localVideoTrack?.setEnabled(false)
        localVideoTrack = null
        localVideoTrackWrapper?.setTrack(null)
        localVideoTrackWrapper = null
        stopWebcamCapture()
        videoCapturer?.dispose()
        videoCapturer = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
        clearVideoSource()
        localVideoEnabled = false
        if (notifyLocalState) {
            onLocalVideoEnabledChanged?.invoke(false)
        }
    }

    private suspend fun ensureRecordAudioPermission(): Boolean {
        if (PermissionHelper.hasRecordAudioPermission()) return true

        return suspendCancellableCoroutine { cont ->
            val callback: (Boolean) -> Unit = { granted ->
                if (cont.isActive) {
                    cont.resume(granted)
                }
            }
            val token = PermissionHelper.requestRecordAudioPermission(callback)
            cont.invokeOnCancellation { token.cancel() }
        }
    }

    private suspend fun ensureCameraPermission(): Boolean {
        if (PermissionHelper.hasCameraPermission()) return true

        return suspendCancellableCoroutine { cont ->
            val callback: (Boolean) -> Unit = { granted ->
                if (cont.isActive) {
                    cont.resume(granted)
                }
            }
            val token = PermissionHelper.requestCameraPermission(callback)
            cont.invokeOnCancellation { token.cancel() }
        }
    }

    private fun disposeAudioTrack(track: AudioTrack?) {
        if (track == null) return
        try {
            track.setEnabled(false)
        } catch (_: Throwable) {
        }
        try {
            track.dispose()
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to dispose audio track: ${error}")
        }
    }

    private fun clearLocalAudioTrack() {
        disposeAudioTrack(localAudioTrack)
        localAudioTrack = null
    }

    private fun clearAudioSource() {
        audioSource?.dispose()
        audioSource = null
    }

    private fun clearLocalAudioCapture() {
        clearLocalAudioTrack()
        clearAudioSource()
    }

    private fun microphoneAudioConstraints(): MediaConstraints {
        return MediaConstraints().apply {
            optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            optional.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
        }
    }

    private fun nextLocalAudioTrackId(): String {
        localAudioTrackSequence += 1
        return "audio$localAudioTrackSequence"
    }

    private fun nextLocalVideoTrackId(): String {
        localVideoTrackSequence += 1
        return "video$localVideoTrackSequence"
    }

    private fun nextScreenVideoTrackId(): String {
        screenVideoTrackSequence += 1
        return "screen$screenVideoTrackSequence"
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

    private fun hasUsableProducer(producer: Producer?): Boolean {
        return producer != null && !producer.isClosed && producer.id.isNotBlank()
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
        val producer = try {
            transport.produce(
                this,
                mediaTrack,
                webcamEncodings(currentVideoQuality, connectionQuality),
                null,
                preferredCodec,
                appData
            )
        } catch (error: Throwable) {
            debugLog("[WebRTC] Webcam simulcast produce failed; retrying single-layer: ${error}")
            transport.produce(
                this,
                mediaTrack,
                null as List<RtpParameters.Encoding>?,
                null,
                null,
                appData
            )
        }
        return requireRegisteredProducer(producer, "webcam")
    }

    private fun produceMicrophoneAudio(
        transport: SendTransport,
        track: AudioTrack,
    ): Producer {
        val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
        // produce(listener, track, encodings, codecOptions, codec, appData): the
        // 5-arg overload's last String is `codec`, so appData must be the 6th arg.
        val producer = transport.produce(
            this,
            track as MediaStreamTrack,
            null,
            microphoneOpusCodecOptionsJson(),
            null,
            appData
        )
        return requireRegisteredProducer(producer, "microphone")
    }

    private suspend fun markMicrophoneProducerUnmuted(producerId: String, reason: String) {
        try {
            socketManager?.toggleMute(producerId, paused = false)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to confirm microphone producer unmuted after ${reason}: ${error}")
        }
    }

    private fun requireRegisteredProducer(producer: Producer, label: String): Producer {
        if (producer.id.isBlank() || producer.isClosed) {
            try {
                producer.close()
            } catch (_: Throwable) {
            }
            throw ErrorException("SFU did not acknowledge $label producer")
        }
        return producer
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
            val capture = screenShareCaptureProfile(
                metrics.widthPixels,
                metrics.heightPixels,
                connectionQuality,
            )
            try {
                screenCapturer?.changeCaptureFormat(
                    capture.width,
                    capture.height,
                    capture.maxFramerate,
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
        val transport = sendTransport ?: return
        val oldProducer = audioProducer ?: return
        val track = localAudioTrack ?: return
        audioBandwidthRefreshInFlight = true
        val callback = onLocalAudioEnabledChanged
        onLocalAudioEnabledChanged = null
        try {
            // Android's mediasoup Producer does not expose live RtpSender
            // parameters. Create the replacement before retiring the old one so
            // a failed refresh never leaves the UI unmuted with no live producer.
            configureCallAudioMode(unmuted = true)
            forceUnmuteMicrophoneCapture()
            track.setEnabled(true)
            val nextProducer = produceMicrophoneAudio(transport, track)
            nextProducer.resume()
            audioProducer = nextProducer
            audioProducerBandwidthQuality = connectionQuality
            localAudioEnabled = true
            localAudioTargetEnabled = true
            forceUnmuteMicrophoneCapture()
            track.setEnabled(true)
            configureCallAudioMode(unmuted = true)
            markMicrophoneProducerUnmuted(nextProducer.id, "bandwidth refresh")

            try {
                socket.closeProducer(oldProducer.id)
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to notify SFU of refreshed microphone producer close: ${error}")
            }
            oldProducer.close()
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
            val nextProducer = requireRegisteredProducer(
                transport.produce(
                    this,
                    track as MediaStreamTrack,
                    screenShareEncodings(connectionQuality),
                    null,
                    preferredCodec,
                    appData,
                ),
                "screen"
            )
            nextProducer.resume()
            screenProducer = nextProducer
            screenProducerBandwidthQuality = connectionQuality
            val metrics = ProcessInfo.processInfo.androidContext.resources.displayMetrics
            val capture = screenShareCaptureProfile(
                metrics.widthPixels,
                metrics.heightPixels,
                connectionQuality,
            )
            try {
                screenCapturer?.changeCaptureFormat(
                    capture.width,
                    capture.height,
                    capture.maxFramerate,
                )
            } catch (_: Throwable) {
            }

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
        if (!hasLocalAudioProducer || !localAudioEnabled || localAudioTrack?.enabled() != true) {
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
                encoding.networkPriority = WEBRTC_NETWORK_PRIORITY_VERY_LOW
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
            ConnectionQuality.emergency -> ScreenShareEncodingCap(
                maxBitrateBps = 220_000,
                maxFramerate = 3,
                maxWidth = 1280,
                maxHeight = 720,
            )
            ConnectionQuality.poor -> ScreenShareEncodingCap(
                maxBitrateBps = 450_000,
                maxFramerate = 5,
                maxWidth = 1920,
                maxHeight = 1080,
            )
            ConnectionQuality.fair -> ScreenShareEncodingCap(
                maxBitrateBps = 1_200_000,
                maxFramerate = 12,
                maxWidth = 2560,
                maxHeight = 1440,
            )
            ConnectionQuality.good, ConnectionQuality.unknown -> ScreenShareEncodingCap(
                maxBitrateBps = 2_500_000,
                maxFramerate = 24,
                maxWidth = 3840,
                maxHeight = 2160,
            )
        }
    }

    private fun screenShareCaptureProfile(
        displayWidth: Int,
        displayHeight: Int,
        connectionQuality: ConnectionQuality,
    ): ScreenShareCaptureProfile {
        val cap = screenShareEncodingCap(connectionQuality)
        val sourceWidth = displayWidth.coerceAtLeast(1)
        val sourceHeight = displayHeight.coerceAtLeast(1)
        val scale = maxOf(
            1.0,
            sourceWidth.toDouble() / cap.maxWidth.toDouble(),
            sourceHeight.toDouble() / cap.maxHeight.toDouble(),
        )
        return ScreenShareCaptureProfile(
            width = evenCaptureDimension((sourceWidth.toDouble() / scale).toInt()),
            height = evenCaptureDimension((sourceHeight.toDouble() / scale).toInt()),
            maxFramerate = cap.maxFramerate,
        )
    }

    private fun evenCaptureDimension(value: Int): Int {
        val dimension = value.coerceAtLeast(2)
        return if (dimension % 2 == 0) dimension else dimension - 1
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
                encoding.networkPriority = WEBRTC_NETWORK_PRIORITY_HIGH
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
            ConnectionQuality.emergency -> 24_000
            ConnectionQuality.poor -> 32_000
            ConnectionQuality.fair -> 48_000
            ConnectionQuality.good, ConnectionQuality.unknown -> 96_000
        }
    }

    internal suspend fun cleanup(notifyLocalState: Boolean = true) {
        configurationGeneration += 1
        PermissionHelper.cancelPendingCallPermissionRequests()
        stopWebcamCapture()
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
        audioProducerRouteRecoveryInFlight = false
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
        localVideoTrack = null
        clearVideoSource()
        clearLocalAudioCapture()
        audioDeviceModule?.setMicrophoneMute(true)
        audioDeviceModule?.setSpeakerMute(false)
        applyAudioModuleInputDevice(null)
        audioStartOrEnableInFlight = false
        localAudioTargetEnabled = false
        bluetoothConnectAutoRequestAttempted = false
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

    internal fun remoteVideoTrack(forUserId: String): VideoTrackWrapper? {
        val normalized = forUserId.trim()
        if (normalized.isEmpty()) return null
        remoteVideoTracks[normalized]?.let { return it }

        val screenSuffix = "-${ProducerType.screen.rawValue}"
        val wantsScreenTrack = normalized.endsWith(screenSuffix)
        val userKey = stableRemoteTrackUserKey(normalized, removeScreenSuffix = wantsScreenTrack)
        if (userKey.isEmpty()) return null

        for (entry in remoteVideoTracks) {
            val candidateKey = entry.key
            val candidateIsScreenTrack = candidateKey.endsWith(screenSuffix)
            if (candidateIsScreenTrack == wantsScreenTrack &&
                stableRemoteTrackUserKey(candidateKey, removeScreenSuffix = candidateIsScreenTrack) == userKey
            ) {
                return entry.value
            }
        }
        return null
    }

    private fun stableRemoteTrackUserKey(userId: String, removeScreenSuffix: Boolean = false): String {
        val screenSuffix = "-${ProducerType.screen.rawValue}"
        val normalized = if (removeScreenSuffix && userId.endsWith(screenSuffix)) {
            userId.dropLast(screenSuffix.length)
        } else {
            userId
        }.trim()
        return normalized.substringBefore("#")
    }

    /// The raw org.webrtc.VideoTrack for a participant's webcam (by user id), or
    /// the local camera track when `userId == "local"`. Used to feed the
    /// Picture-in-Picture window the active speaker's video.
    internal fun rawVideoTrack(userId: String): VideoTrack? {
        if (userId == "local") {
            return localVideoTrack
        }
        return remoteVideoTrack(forUserId = userId)?.rtcVideoTrack
    }

    // MARK: - Audio Device Routing

    private fun audioManager(): AudioManager? {
        val context = ProcessInfo.processInfo.androidContext
        return context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    }

    private fun configureCallAudioMode(unmuted: Boolean = false) {
        val manager = audioManager() ?: return
        try {
            val startedAt = System.nanoTime()
            val wasActive = isCallAudioModeActive
            val shouldRecord = unmuted || localAudioTargetEnabled || localAudioEnabled || audioStartOrEnableInFlight
            if (
                wasActive &&
                !shouldRecord &&
                manager.mode == AudioManager.MODE_IN_COMMUNICATION &&
                lastAppliedAudioRouteSignature != null
            ) {
                return
            }
            NativePerformanceDiagnostics.event(
                "audio_mode_configure",
                "unmuted=$unmuted wasActive=$wasActive focusHeld=$hasCallAudioFocus"
            )
            audioCaptureReassertionGeneration += 1
            isCallAudioModeActive = true
            requestCallAudioFocus(manager)
            startAudioDeviceRouteMonitor(manager)
            requestBluetoothRoutingPermissionIfNeeded(manager)
            val preselectedRouteChanged = if (Build.VERSION.SDK_INT >= 31) {
                val changed = applyPreferredCommunicationRoute(manager)
                NativePerformanceDiagnostics.event("audio_route_preselect", "changed=$changed")
                changed
            } else {
                false
            }
            ensureCommunicationMode(manager)
            val routeChanged = if (Build.VERSION.SDK_INT >= 31) {
                val postselectedRouteChanged = applyPreferredCommunicationRoute(manager)
                preselectedRouteChanged || postselectedRouteChanged
            } else {
                applyPreferredCommunicationRoute(manager)
            }
            applyLocalAudioCaptureState(manager, shouldLocalAudioCaptureStayActive(shouldRecord))
            restartLocalAudioTrackAfterRouteChange(routeChanged, "call audio mode configure")
            scheduleLocalAudioCaptureReassertion(shouldRecord)
            NativePerformanceDiagnostics.timingAlways("audio_mode_configure", startedAt, "record=$shouldRecord routeChanged=$routeChanged")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to configure call audio mode: ${error}")
        }
    }

    private fun releaseCallAudioMode() {
        isCallAudioModeActive = false
        audioRouteReapplyScheduled = false
        delayedAudioRouteReapplyRunnable?.let { mainHandler.removeCallbacks(it) }
        delayedAudioRouteReapplyRunnable = null
        audioCaptureRestartScheduled = false
        lastAppliedAudioRouteSignature = null
        audioRouteMismatchSignature = null
        audioRouteMismatchReapplyAttempts = 0
        audioCaptureReassertionGeneration += 1
        val manager = audioManager() ?: return
        try {
            stopAudioDeviceRouteMonitor(manager)
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
            manager.isMicrophoneMute = false
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to release call audio mode: ${error}")
        } finally {
            releaseCallAudioFocus(manager)
            try {
                manager.mode = AudioManager.MODE_NORMAL
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to restore normal audio mode: ${error}")
            }
        }
    }

    private fun ensureCommunicationMode(manager: AudioManager) {
        try {
            if (manager.mode == AudioManager.MODE_IN_COMMUNICATION) return
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            NativePerformanceDiagnostics.event("audio_mode_set", "mode=in_communication")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to set communication audio mode: ${error}")
        }
    }

    private fun requestCallAudioFocus(manager: AudioManager) {
        if (hasCallAudioFocus) return
        try {
            val result = if (Build.VERSION.SDK_INT >= 26) {
                val request = audioFocusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(audioFocusChangeListener, mainHandler)
                    .build()
                    .also { audioFocusRequest = it }
                manager.requestAudioFocus(request)
            } else {
                @Suppress("DEPRECATION")
                manager.requestAudioFocus(
                    audioFocusChangeListener,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN
                )
            }
            hasCallAudioFocus = result != AudioManager.AUDIOFOCUS_REQUEST_FAILED
            NativePerformanceDiagnostics.event("audio_focus_request", "result=$result held=$hasCallAudioFocus")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to request call audio focus: ${error}")
        }
    }

    private fun releaseCallAudioFocus(manager: AudioManager) {
        if (!hasCallAudioFocus && audioFocusRequest == null) return
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                audioFocusRequest?.let { manager.abandonAudioFocusRequest(it) }
                audioFocusRequest = null
            } else {
                @Suppress("DEPRECATION")
                manager.abandonAudioFocus(audioFocusChangeListener)
            }
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to release call audio focus: ${error}")
        } finally {
            hasCallAudioFocus = false
        }
    }

    private fun startAudioDeviceRouteMonitor(manager: AudioManager) {
        if (audioDeviceCallback == null) {
            val callback = object : AudioDeviceCallback() {
                override fun onAudioDevicesAdded(addedDevices: kotlin.Array<out AudioDeviceInfo>?) {
                    scheduleCallAudioRouteReapply(forceCaptureRestart = shouldLocalAudioCaptureStayActive())
                }

                override fun onAudioDevicesRemoved(removedDevices: kotlin.Array<out AudioDeviceInfo>?) {
                    scheduleCallAudioRouteReapply(forceCaptureRestart = shouldLocalAudioCaptureStayActive())
                }
            }
            audioDeviceCallback = callback
            try {
                manager.registerAudioDeviceCallback(callback, mainHandler)
            } catch (error: Throwable) {
                audioDeviceCallback = null
                debugLog("[WebRTC] Failed to watch audio devices: ${error}")
            }
        }

        if (Build.VERSION.SDK_INT >= 31 && communicationDeviceChangedListener == null) {
            val listener = AudioManager.OnCommunicationDeviceChangedListener {
                scheduleCallAudioRouteReapply(forceCaptureRestart = shouldLocalAudioCaptureStayActive())
            }
            communicationDeviceChangedListener = listener
            try {
                val mainExecutor = java.util.concurrent.Executor { command ->
                    mainHandler.post(command)
                }
                manager.addOnCommunicationDeviceChangedListener(mainExecutor, listener)
            } catch (error: Throwable) {
                communicationDeviceChangedListener = null
                debugLog("[WebRTC] Failed to watch communication device: ${error}")
            }
        }
    }

    private fun stopAudioDeviceRouteMonitor(manager: AudioManager) {
        val callback = audioDeviceCallback
        if (callback != null) {
            audioDeviceCallback = null
            try {
                manager.unregisterAudioDeviceCallback(callback)
            } catch (_: Throwable) {
            }
        }

        if (Build.VERSION.SDK_INT >= 31) {
            val listener = communicationDeviceChangedListener
            communicationDeviceChangedListener = null
            if (listener != null) {
                try {
                    manager.removeOnCommunicationDeviceChangedListener(listener)
                } catch (_: Throwable) {
                }
            }
        } else {
            communicationDeviceChangedListener = null
        }
    }

    private fun scheduleCallAudioRouteReapply(forceCaptureRestart: Boolean = false) {
        if (!isCallAudioModeActive) return
        if (!shouldLocalAudioCaptureStayActive() && lastAppliedAudioRouteSignature != null) {
            NativePerformanceDiagnostics.event(
                "audio_route_reapply_skip",
                "reason=muted forceCaptureRestart=$forceCaptureRestart"
            )
            notifyCallAudioRouteChanged()
            return
        }
        if (forceCaptureRestart) {
            scheduleDelayedCallAudioRouteReapply()
        }
        if (audioRouteReapplyScheduled) return
        audioRouteReapplyScheduled = true
        mainHandler.post {
            audioRouteReapplyScheduled = false
            val now = SystemClock.uptimeMillis()
            if (now - lastAudioRouteReapplyAtMs < 700L) {
                scheduleDelayedCallAudioRouteReapply()
                return@post
            }
            reapplyCallAudioRoute(forceCaptureRestart = false)
        }
    }

    private fun scheduleDelayedCallAudioRouteReapply() {
        delayedAudioRouteReapplyRunnable?.let { mainHandler.removeCallbacks(it) }
        val reapply = object : Runnable {
            override fun run() {
                if (delayedAudioRouteReapplyRunnable !== this) return
                delayedAudioRouteReapplyRunnable = null
                reapplyCallAudioRoute(forceCaptureRestart = false)
            }
        }
        delayedAudioRouteReapplyRunnable = reapply
        mainHandler.postDelayed(reapply, 450L)
    }

    private fun reapplyCallAudioRoute(forceCaptureRestart: Boolean = false) {
        val manager = audioManager() ?: return
        if (!isCallAudioModeActive) return
        try {
            val startedAt = System.nanoTime()
            val shouldRecord = shouldLocalAudioCaptureStayActive()
            if (!shouldRecord && lastAppliedAudioRouteSignature != null) {
                NativePerformanceDiagnostics.event(
                    "audio_route_reapply_skip",
                    "reason=muted_in_reapply forceCaptureRestart=$forceCaptureRestart"
                )
                notifyCallAudioRouteChanged()
                return
            }
            lastAudioRouteReapplyAtMs = SystemClock.uptimeMillis()
            NativePerformanceDiagnostics.event("audio_route_reapply", "forceCaptureRestart=$forceCaptureRestart")
            requestCallAudioFocus(manager)
            ensureCommunicationMode(manager)
            requestBluetoothRoutingPermissionIfNeeded(manager)
            val routeChanged = applyPreferredCommunicationRoute(manager)
            applyLocalAudioCaptureState(manager, shouldRecord)
            restartLocalAudioTrackAfterRouteChange(
                routeChanged && shouldRecord,
                "audio route change"
            )
            scheduleLocalAudioCaptureReassertion(shouldRecord)
            notifyCallAudioRouteChanged()
            NativePerformanceDiagnostics.timingAlways("audio_route_reapply", startedAt, "record=$shouldRecord routeChanged=$routeChanged")
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to re-apply communication route: ${error}")
        }
    }

    private fun notifyCallAudioRouteChanged() {
        val callback = onCallAudioRouteChanged ?: return
        if (audioRouteChangeNotificationScheduled) return
        audioRouteChangeNotificationScheduled = true
        mainHandler.post {
            audioRouteChangeNotificationScheduled = false
            if (isCallAudioModeActive) {
                callback.invoke()
            }
        }
    }

    private fun applyLocalAudioCaptureState(manager: AudioManager, shouldRecord: Boolean) {
        if (shouldRecord) {
            manager.isMicrophoneMute = false
        }
        audioDeviceModule?.setMicrophoneMute(!shouldRecord)
        audioDeviceModule?.setSpeakerMute(false)
        localAudioTrack?.setEnabled(shouldRecord)
        if (shouldRecord) {
            val producer = audioProducer
            if (
                !audioStartOrEnableInFlight &&
                !audioBandwidthRefreshInFlight &&
                !hasLocalAudioProducer
            ) {
                onLocalAudioProducerLost?.invoke()
                return
            }
            try {
                producer?.resume()
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to reassert audio producer capture: ${error}")
                if (!audioStartOrEnableInFlight && !audioBandwidthRefreshInFlight) {
                    onLocalAudioProducerLost?.invoke()
                }
            }
        }
    }

    private fun forceUnmuteMicrophoneCapture() {
        audioDeviceModule?.setMicrophoneMute(false)
        try {
            audioManager()?.isMicrophoneMute = false
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to unmute system microphone: ${error}")
        }
    }

    private fun reassertCallAudioCaptureIfActive(manager: AudioManager) {
        if (!isCallAudioModeActive) return
        val shouldRecord = shouldLocalAudioCaptureStayActive()
        applyLocalAudioCaptureState(manager, shouldRecord)
        scheduleLocalAudioCaptureReassertion(shouldRecord)
    }

    private fun shouldLocalAudioCaptureStayActive(requested: Boolean): Boolean {
        return localAudioTargetEnabled && (requested || localAudioEnabled || audioStartOrEnableInFlight)
    }

    private fun shouldLocalAudioCaptureStayActive(): Boolean {
        return shouldLocalAudioCaptureStayActive(localAudioTargetEnabled || localAudioEnabled || audioStartOrEnableInFlight)
    }

    private fun scheduleLocalAudioCaptureReassertion(shouldRecord: Boolean) {
        if (!shouldRecord) return
        scheduleLocalAudioCaptureReassertion(250L)
        scheduleLocalAudioCaptureReassertion(1_000L)
        scheduleLocalAudioCaptureReassertion(2_500L)
        scheduleLocalAudioCaptureReassertion(5_000L)
    }

    private fun scheduleLocalAudioCaptureReassertion(delayMs: Long) {
        val generation = audioCaptureReassertionGeneration
        mainHandler.postDelayed({
            val manager = audioManager() ?: return@postDelayed
            if (generation != audioCaptureReassertionGeneration) return@postDelayed
            if (!isCallAudioModeActive) return@postDelayed
            val active = shouldLocalAudioCaptureStayActive()
            var routeChanged = false
            if (active) {
                routeChanged = applyPreferredCommunicationRoute(manager)
            }
            applyLocalAudioCaptureState(manager, active)
            restartLocalAudioTrackAfterRouteChange(routeChanged && active, "audio route reassertion")
            if (routeChanged && active) {
                notifyCallAudioRouteChanged()
            }
        }, delayMs)
    }

    private fun restartLocalAudioTrackAfterRouteChange(routeChanged: Boolean, reason: String) {
        if (!routeChanged) return
        restartLocalAudioTrack(reason)
    }

    private fun restartLocalAudioTrack(reason: String) {
        if (!shouldLocalAudioCaptureStayActive()) return
        if (audioStartOrEnableInFlight || audioBandwidthRefreshInFlight) return
        if (!hasLocalAudioProducer) {
            onLocalAudioProducerLost?.invoke()
            return
        }
        if (audioProducerRouteRecoveryInFlight) return
        if (audioCaptureRestartScheduled) return
        val generation = audioCaptureReassertionGeneration
        audioCaptureRestartScheduled = true
        debugLog("[WebRTC] Restarting microphone track after ${reason}")
        localAudioTrack?.setEnabled(false)
        mainHandler.postDelayed({
            audioCaptureRestartScheduled = false
            if (generation != audioCaptureReassertionGeneration) return@postDelayed
            if (!isCallAudioModeActive || !shouldLocalAudioCaptureStayActive()) return@postDelayed
            localAudioTrack?.setEnabled(true)
            audioManager()?.let { manager ->
                applyPreferredCommunicationRoute(manager)
                applyLocalAudioCaptureState(manager, true)
            }
            recreateLocalAudioProducerAfterRouteRecovery(reason)
            notifyCallAudioRouteChanged()
        }, 80L)
    }

    private fun recreateLocalAudioProducerAfterRouteRecovery(reason: String) {
        if (audioProducerRouteRecoveryInFlight) return
        if (audioStartOrEnableInFlight || audioBandwidthRefreshInFlight) return
        if (!isCallAudioModeActive || !shouldLocalAudioCaptureStayActive()) return
        val generation = configurationGeneration
        val socket = socketManager ?: return
        val transport = sendTransport ?: return
        val producerAtSchedule = audioProducer ?: return
        if (!hasUsableProducer(producerAtSchedule)) {
            onLocalAudioProducerLost?.invoke()
            return
        }
        val factory = peerConnectionFactory ?: return

        audioProducerRouteRecoveryInFlight = true
        audioRouteRecoveryScope.launch {
            var nextSource: AudioSource? = null
            var nextTrack: AudioTrack? = null
            var nextProducer: Producer? = null

            try {
                if (
                    generation != configurationGeneration ||
                    !isCallAudioModeActive ||
                    !shouldLocalAudioCaptureStayActive()
                ) {
                    return@launch
                }

                configureCallAudioMode(unmuted = true)
                nextSource = factory.createAudioSource(microphoneAudioConstraints())
                nextTrack = factory.createAudioTrack(nextLocalAudioTrackId(), nextSource)
                val track = nextTrack ?: throw ErrorException("Audio track unavailable")
                forceUnmuteMicrophoneCapture()
                track.setEnabled(true)

                val replacement = produceMicrophoneAudio(transport, track)
                nextProducer = replacement
                replacement.resume()

                if (
                    generation != configurationGeneration ||
                    !isCallAudioModeActive ||
                    !shouldLocalAudioCaptureStayActive()
                ) {
                    return@launch
                }

                val previousProducer = audioProducer
                val previousTrack = localAudioTrack
                val previousSource = audioSource

                audioProducer = replacement
                audioProducerBandwidthQuality = currentLocalBandwidthQuality
                audioSource = nextSource
                localAudioTrack = track
                localAudioEnabled = true
                localAudioTargetEnabled = true
                onLocalAudioEnabledChanged?.invoke(true)
                nextSource = null
                nextTrack = null
                nextProducer = null

                forceUnmuteMicrophoneCapture()
                audioManager()?.let { manager ->
                    applyPreferredCommunicationRoute(manager)
                    applyLocalAudioCaptureState(manager, true)
                }
                markMicrophoneProducerUnmuted(replacement.id, "route recovery")

                if (previousProducer != null && previousProducer.id != replacement.id) {
                    try {
                        socket.closeProducer(previousProducer.id)
                    } catch (error: Throwable) {
                        debugLog("[WebRTC] Failed to notify SFU of recovered microphone producer close: ${error}")
                    }
                    previousProducer.close()
                }
                disposeAudioTrack(previousTrack)
                previousSource?.dispose()
                debugLog("[WebRTC] Recreated microphone producer after ${reason}")
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to recreate microphone producer after ${reason}: ${error}")
                if (
                    generation == configurationGeneration &&
                    isCallAudioModeActive &&
                    shouldLocalAudioCaptureStayActive()
                ) {
                    forceUnmuteMicrophoneCapture()
                    localAudioTrack?.setEnabled(true)
                    try {
                        audioProducer?.resume()
                    } catch (resumeError: Throwable) {
                        debugLog("[WebRTC] Failed to resume existing microphone producer after recovery failure: ${resumeError}")
                        onLocalAudioProducerLost?.invoke()
                    }
                }
            } finally {
                closeUncommittedReplacementProducer(
                    producer = nextProducer,
                    socket = socket,
                    reason = "route recovery",
                )
                disposeAudioTrack(nextTrack)
                nextSource?.dispose()
                audioProducerRouteRecoveryInFlight = false
            }
        }
    }

    private suspend fun closeUncommittedReplacementProducer(
        producer: Producer?,
        socket: SocketIOManager,
        reason: String,
    ) {
        val producerId = producer?.id?.trim().orEmpty()
        if (producer == null || producerId.isBlank()) return
        if (producerId != audioProducer?.id?.trim().orEmpty()) {
            try {
                socket.closeProducer(producerId)
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to notify SFU of uncommitted microphone producer close after ${reason}: ${error}")
            }
        }
        producer.close()
    }

    private fun recoverCallAudioAfterAdmError(reason: String, recoverCapture: Boolean) {
        mainHandler.post {
            if (!isCallAudioModeActive) return@post
            debugLog("[WebRTC] Reasserting call audio after ${reason}")
            val shouldRecoverCapture = recoverCapture && shouldLocalAudioCaptureStayActive()
            configureCallAudioMode(unmuted = shouldRecoverCapture)
            if (shouldRecoverCapture) {
                if (localAudioTrack == null || !hasUsableProducer(audioProducer)) {
                    onLocalAudioProducerLost?.invoke()
                } else {
                    restartLocalAudioTrack(reason)
                }
            }
            notifyCallAudioRouteChanged()
        }
    }

    // Friendly label for an AudioDeviceInfo type, mirroring the route names the
    // web/iOS clients surface (Speaker / Earpiece / Bluetooth / Wired headset).
    private fun deviceLabel(info: AudioDeviceInfo): String {
        return when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_HEARING_AID -> {
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
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }
    }

    private fun isBluetoothRoute(info: AudioDeviceInfo): Boolean {
        return when (info.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }
    }

    private fun isBluetoothOutputOnlyRoute(info: AudioDeviceInfo): Boolean {
        return when (info.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }
    }

    private fun canApplyCommunicationRoute(info: AudioDeviceInfo): Boolean {
        return Build.VERSION.SDK_INT < 31 ||
            !isBluetoothRoute(info) ||
            PermissionHelper.hasBluetoothConnectPermission()
    }

    private fun communicationRouteCandidates(devices: List<AudioDeviceInfo>): List<AudioDeviceInfo> {
        if (Build.VERSION.SDK_INT < 31 || PermissionHelper.hasBluetoothConnectPermission()) {
            return devices
        }
        return devices.filter { canApplyCommunicationRoute(it) }
    }

    private fun isInputCapableCallRoute(info: AudioDeviceInfo): Boolean {
        if (!isAudioInputSource(info)) return false
        return when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET -> true
            else -> false
        }
    }

    private fun isOutputCapableCallRoute(info: AudioDeviceInfo): Boolean {
        if (!isAudioOutputSink(info)) return false
        return when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }
    }

    private fun callRoutePriority(info: AudioDeviceInfo): Int {
        return when (info.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 0
            AudioDeviceInfo.TYPE_BLE_HEADSET -> 1
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> 2
            AudioDeviceInfo.TYPE_USB_HEADSET -> 3
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> 4
            AudioDeviceInfo.TYPE_USB_DEVICE -> 5
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> 6
            AudioDeviceInfo.TYPE_BLE_SPEAKER -> 7
            AudioDeviceInfo.TYPE_HEARING_AID -> 8
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 9
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> 10
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> 11
            else -> 20
        }
    }

    private fun sortedCallRoutes(devices: List<AudioDeviceInfo>): List<AudioDeviceInfo> {
        return devices.sortedWith(compareBy<AudioDeviceInfo> { callRoutePriority(it) }.thenBy { deviceLabel(it) })
    }

    private fun dedupeAudioDevices(devices: List<AudioDeviceInfo>): List<AudioDeviceInfo> {
        val seen = mutableSetOf<String>()
        return devices.filter {
            seen.add("${it.type}:${it.id}:${audioDeviceDirectionKey(it)}")
        }
    }

    private enum class AudioDeviceSelectionDirection(val prefix: String) {
        input("in"),
        output("out")
    }

    private fun audioDeviceSelectionId(
        info: AudioDeviceInfo,
        direction: AudioDeviceSelectionDirection
    ): String {
        return "${direction.prefix}:${info.id}"
    }

    private fun audioDeviceIdMatches(
        selectionId: String?,
        info: AudioDeviceInfo,
        direction: AudioDeviceSelectionDirection? = null
    ): Boolean {
        val trimmed = selectionId?.trim().orEmpty()
        if (trimmed.isEmpty()) return false

        val separator = trimmed.indexOf(':')
        if (separator > 0) {
            val prefix = trimmed.substring(0, separator)
            val rawId = trimmed.substring(separator + 1)
            if (direction != null && prefix != direction.prefix) {
                return false
            }
            if (prefix == AudioDeviceSelectionDirection.input.prefix ||
                prefix == AudioDeviceSelectionDirection.output.prefix
            ) {
                return rawId == info.id.toString()
            }
        }

        // Backward compatibility for any state captured before Android route
        // picker ids became direction-scoped.
        return trimmed == info.id.toString()
    }

    private fun audioDeviceDirectionKey(info: AudioDeviceInfo): String {
        val source = try {
            info.isSource
        } catch (_: Throwable) {
            false
        }
        val sink = try {
            info.isSink
        } catch (_: Throwable) {
            false
        }
        return "${source}:${sink}"
    }

    private fun isAudioInputSource(info: AudioDeviceInfo): Boolean {
        return try {
            info.isSource
        } catch (_: Throwable) {
            false
        }
    }

    private fun isAudioOutputSink(info: AudioDeviceInfo): Boolean {
        return try {
            info.isSink
        } catch (_: Throwable) {
            false
        }
    }

    private fun safeAudioDevices(manager: AudioManager, flags: Int): List<AudioDeviceInfo> {
        return try {
            manager.getDevices(flags).toList()
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to list audio devices: ${error}")
            emptyList()
        }
    }

    private fun communicationDevices(manager: AudioManager): List<AudioDeviceInfo> {
        return if (Build.VERSION.SDK_INT >= 31) {
            val hasBluetoothPermission = PermissionHelper.hasBluetoothConnectPermission()
            try {
                val devices = manager.availableCommunicationDevices
                if (hasBluetoothPermission) {
                    devices
                } else {
                    devices.filterNot { isBluetoothRoute(it) }
                }
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to list communication devices: ${error}")
                val fallback = safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
                    safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
                fallback.filter { !isBluetoothRoute(it) || hasBluetoothPermission }
            }
        } else {
            safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS)
        }
    }

    private fun callRouteDevices(manager: AudioManager): List<AudioDeviceInfo> {
        return if (Build.VERSION.SDK_INT >= 31) {
            dedupeAudioDevices(
                communicationDevices(manager) +
                    safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
                    safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
            )
        } else {
            dedupeAudioDevices(
                safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
                    safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
            )
        }
    }

    private fun currentCommunicationDevice(manager: AudioManager): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < 31) {
            return null
        }
        return try {
            manager.communicationDevice
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to read communication device: ${error}")
            null
        }
    }

    private fun selectedRouteNeedsBluetoothConnectPermission(manager: AudioManager): Boolean {
        if (Build.VERSION.SDK_INT < 31 || PermissionHelper.hasBluetoothConnectPermission()) {
            return false
        }
        val selectedIds = listOfNotNull(selectedAudioInputDeviceId, selectedAudioOutputDeviceId)
            .filter { it.isNotBlank() }
        if (selectedIds.isEmpty()) return false

        val devices = safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
            safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
        return devices.any { info ->
            selectedIds.any { audioDeviceIdMatches(it, info) } && isBluetoothRoute(info)
        }
    }

    private fun isPermissionHiddenBluetoothRoute(manager: AudioManager, selectedId: String): Boolean {
        if (Build.VERSION.SDK_INT < 31 || PermissionHelper.hasBluetoothConnectPermission()) {
            return false
        }
        val devices = safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
            safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
        return devices.any { info ->
            audioDeviceIdMatches(selectedId, info) && isBluetoothRoute(info)
        }
    }

    private fun hasVisibleBluetoothCallRoute(manager: AudioManager): Boolean {
        if (Build.VERSION.SDK_INT < 31) {
            return false
        }
        try {
            if (manager.availableCommunicationDevices.any { isBluetoothRoute(it) }) {
                return true
            }
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to inspect Bluetooth communication routes: ${error}")
        }
        val devices = safeAudioDevices(manager, AudioManager.GET_DEVICES_OUTPUTS) +
            safeAudioDevices(manager, AudioManager.GET_DEVICES_INPUTS)
        return devices.any { isBluetoothRoute(it) }
    }

    private fun requestBluetoothRoutingPermissionIfNeeded(manager: AudioManager) {
        val hasBluetoothRoute = selectedRouteNeedsBluetoothConnectPermission(manager) ||
            hasVisibleBluetoothCallRoute(manager)
        if (
            Build.VERSION.SDK_INT < 31 ||
            PermissionHelper.hasBluetoothConnectPermission() ||
            bluetoothConnectAutoRequestAttempted ||
            !hasBluetoothRoute
        ) {
            return
        }
        bluetoothConnectAutoRequestAttempted = true
        requestBluetoothConnectPermissionThenReapplyRoute()
    }

    private fun inputDevices(manager: AudioManager): List<AudioDeviceInfo> {
        return sortedCallRoutes(callRouteDevices(manager).filter { isInputCapableCallRoute(it) })
    }

    private fun outputDevices(manager: AudioManager): List<AudioDeviceInfo> {
        val devices = if (Build.VERSION.SDK_INT >= 31) {
            communicationDevices(manager)
        } else {
            callRouteDevices(manager)
        }
        return sortedCallRoutes(devices.filter { isOutputCapableCallRoute(it) })
    }

    private fun bestCaptureInput(
        manager: AudioManager,
        routeDevices: List<AudioDeviceInfo> = emptyList(),
        selectedInputId: String?,
        preferredOutput: AudioDeviceInfo?
    ): AudioDeviceInfo? {
        val sourceDevices = if (routeDevices.isEmpty()) {
            inputDevices(manager)
        } else {
            sortedCallRoutes(
                dedupeAudioDevices(routeDevices + inputDevices(manager))
                    .filter { isInputCapableCallRoute(it) }
            )
        }
        val inputCandidates = communicationRouteCandidates(
            sourceDevices
        )
        if (!selectedInputId.isNullOrBlank()) {
            inputCandidates.firstOrNull { audioDeviceIdMatches(selectedInputId, it, AudioDeviceSelectionDirection.input) }?.let { return it }
            routeDevices.firstOrNull {
                audioDeviceIdMatches(selectedInputId, it, AudioDeviceSelectionDirection.input) &&
                    isInputCapableCallRoute(it) &&
                    canApplyCommunicationRoute(it)
            }?.let { return it }
        }

        preferredOutput
            ?.takeIf { isInputCapableCallRoute(it) && canApplyCommunicationRoute(it) }
            ?.let { return it }
        inputCandidates.firstOrNull { isExternalCallRoute(it) }?.let { return it }
        inputCandidates.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }?.let { return it }
        return inputCandidates.firstOrNull()
    }

    private fun applyAudioModuleInputDevice(device: AudioDeviceInfo?) {
        try {
            audioDeviceModule?.setPreferredInputDevice(device)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to apply preferred input device: ${error}")
        }
    }

    private fun audioRouteKey(device: AudioDeviceInfo?): String {
        return if (device == null) "default" else "${device.type}:${device.id}"
    }

    private fun rememberAppliedAudioRoute(
        output: AudioDeviceInfo?,
        input: AudioDeviceInfo?
    ): Boolean {
        val signature = "${audioRouteKey(output)}|${audioRouteKey(input)}"
        val changed = signature != lastAppliedAudioRouteSignature
        lastAppliedAudioRouteSignature = signature
        return changed
    }

    private fun isSameAudioDevice(lhs: AudioDeviceInfo?, rhs: AudioDeviceInfo?): Boolean {
        return lhs != null && rhs != null && lhs.id == rhs.id && lhs.type == rhs.type
    }

    private fun isSameNullableAudioDevice(lhs: AudioDeviceInfo?, rhs: AudioDeviceInfo?): Boolean {
        return (lhs == null && rhs == null) || isSameAudioDevice(lhs, rhs)
    }

    private fun defaultCommunicationTarget(
        devices: List<AudioDeviceInfo>,
        shouldRecord: Boolean,
        excluding: AudioDeviceInfo? = null,
        hasCaptureInput: Boolean = !shouldRecord || devices.any { isInputCapableCallRoute(it) }
    ): AudioDeviceInfo? {
        val candidates = devices.filterNot { isSameAudioDevice(it, excluding) }
        val fullDuplexExternal = candidates.firstOrNull {
            isExternalCallRoute(it) &&
                isInputCapableCallRoute(it) &&
                isOutputCapableCallRoute(it)
        }
        if (fullDuplexExternal != null) {
            return fullDuplexExternal
        }

        val outputOnlyExternal = automaticExternalOutput(candidates, shouldRecord, hasCaptureInput)
        if (outputOnlyExternal != null) {
            return outputOnlyExternal
        }

        return candidates.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } ?: candidates.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        } ?: candidates.firstOrNull {
            isExternalCallRoute(it) &&
                isOutputCapableCallRoute(it)
        }
    }

    private fun automaticExternalOutput(
        devices: List<AudioDeviceInfo>,
        shouldRecord: Boolean,
        hasCaptureInput: Boolean = !shouldRecord || devices.any { isInputCapableCallRoute(it) }
    ): AudioDeviceInfo? {
        return devices.firstOrNull {
            isExternalCallRoute(it) &&
                isOutputCapableCallRoute(it) &&
                (!isBluetoothOutputOnlyRoute(it) || hasCaptureInput)
        }
    }

    private fun applyCommunicationDevice(
        manager: AudioManager,
        target: AudioDeviceInfo?
    ): Boolean {
        if (Build.VERSION.SDK_INT < 31) {
            return true
        }
        return if (target != null) {
            manager.setCommunicationDevice(target)
        } else {
            manager.clearCommunicationDevice()
            true
        }
    }

    private fun reportedCommunicationRouteAfterApply(
        manager: AudioManager,
        requested: AudioDeviceInfo?
    ): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < 31) return requested

        val current = currentCommunicationDevice(manager)
        if (requested != null && !isSameAudioDevice(current, requested)) {
            val mismatchSignature = audioRouteKey(requested)
            if (audioRouteMismatchSignature != mismatchSignature) {
                audioRouteMismatchSignature = mismatchSignature
                audioRouteMismatchReapplyAttempts = 0
            }
            if (audioRouteMismatchReapplyAttempts < 3) {
                audioRouteMismatchReapplyAttempts += 1
                scheduleDelayedCallAudioRouteReapply()
            }
        } else {
            audioRouteMismatchSignature = null
            audioRouteMismatchReapplyAttempts = 0
        }
        return current
    }

    private fun fallbackOutputDevice(devices: List<AudioDeviceInfo>): AudioDeviceInfo? {
        return devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            ?: devices.firstOrNull { isOutputCapableCallRoute(it) }
    }

    private fun applyPreferredCommunicationRoute(manager: AudioManager): Boolean {
        normalizeSelectedAudioRouteIds(manager)

        val selectedOutput = selectedAudioOutputDeviceId
        val selectedInput = selectedAudioInputDeviceId
        if (Build.VERSION.SDK_INT >= 31) {
            val routeDevices = communicationRouteCandidates(sortedCallRoutes(callRouteDevices(manager)))
            val outputCandidates = outputDevices(manager)
            val shouldRecord = shouldLocalAudioCaptureStayActive()
            val selectedOutputDevice =
                selectedOutput?.let { id ->
                    outputCandidates.firstOrNull {
                        audioDeviceIdMatches(id, it, AudioDeviceSelectionDirection.output)
                    }
                }
            val selectedInputDevice =
                selectedInput?.let { id ->
                    routeDevices.firstOrNull {
                        audioDeviceIdMatches(id, it, AudioDeviceSelectionDirection.input) &&
                            isInputCapableCallRoute(it)
                    }
                }
            val selectedOutputForCommunication = selectedOutputDevice
            val selectedInputForCommunication =
                selectedInputDevice?.takeIf { isOutputCapableCallRoute(it) }
            val hasCaptureInput = !shouldRecord || routeDevices.any { isInputCapableCallRoute(it) }
            val target = selectedOutputForCommunication
                ?: selectedInputForCommunication
                ?: defaultCommunicationTarget(outputCandidates, shouldRecord, hasCaptureInput = hasCaptureInput)
            try {
                val currentTarget = currentCommunicationDevice(manager)
                val appliedTarget = if (isSameNullableAudioDevice(currentTarget, target)) {
                    target
                } else if (applyCommunicationDevice(manager, target)) {
                    target
                } else {
                    val fallbackTarget = defaultCommunicationTarget(
                        devices = outputCandidates,
                        shouldRecord = shouldRecord,
                        excluding = target,
                        hasCaptureInput = hasCaptureInput
                    )
                    if (applyCommunicationDevice(manager, fallbackTarget)) {
                        fallbackTarget
                    } else {
                        manager.clearCommunicationDevice()
                        null
                    }
                }
                val preferredInput = selectedInputDevice ?: bestCaptureInput(
                    manager = manager,
                    routeDevices = routeDevices,
                    selectedInputId = selectedInput,
                    preferredOutput = appliedTarget
                )
                applyAudioModuleInputDevice(preferredInput)
                val reportedTarget = if (isSameNullableAudioDevice(currentTarget, appliedTarget)) {
                    currentTarget
                } else {
                    reportedCommunicationRouteAfterApply(manager, appliedTarget)
                }
                return rememberAppliedAudioRoute(reportedTarget, preferredInput)
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to apply communication route: ${error}")
                val fallbackInput = bestCaptureInput(
                    manager = manager,
                    routeDevices = routeDevices,
                    selectedInputId = null,
                    preferredOutput = null
                )
                applyAudioModuleInputDevice(fallbackInput)
                return rememberAppliedAudioRoute(currentCommunicationDevice(manager), fallbackInput)
            }
        }

        var preferredInput: AudioDeviceInfo? = null
        val shouldRecord = shouldLocalAudioCaptureStayActive()
        @Suppress("DEPRECATION")
        if (!selectedOutput.isNullOrBlank()) {
            val target = outputDevices(manager)
                .firstOrNull { audioDeviceIdMatches(selectedOutput, it, AudioDeviceSelectionDirection.output) }
            if (target != null) {
                setSpeakerphoneEnabled(manager, target.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
                setBluetoothScoEnabled(manager, target.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
                if (isInputCapableCallRoute(target)) {
                    preferredInput = target
                }
                if (!selectedInput.isNullOrBlank()) {
                    preferredInput = inputDevices(manager).firstOrNull {
                        audioDeviceIdMatches(selectedInput, it, AudioDeviceSelectionDirection.input)
                    }
                        ?: preferredInput
                }
                val appliedInput = preferredInput ?: bestCaptureInput(
                    manager = manager,
                    selectedInputId = selectedInput,
                    preferredOutput = target
                )
                applyAudioModuleInputDevice(appliedInput)
                return rememberAppliedAudioRoute(target, appliedInput)
            }
        }

        if (!selectedInput.isNullOrBlank()) {
            val target = inputDevices(manager).firstOrNull {
                audioDeviceIdMatches(selectedInput, it, AudioDeviceSelectionDirection.input)
            }
            if (target != null) {
                val routeOutputs = sortedCallRoutes(outputDevices(manager))
                val externalOutput = automaticExternalOutput(
                    devices = routeOutputs,
                    shouldRecord = shouldRecord,
                    hasCaptureInput = true
                )
                setSpeakerphoneEnabled(manager, externalOutput == null)
                setBluetoothScoEnabled(manager, externalOutput?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
                val appliedInput = bestCaptureInput(
                    manager = manager,
                    routeDevices = routeOutputs,
                    selectedInputId = selectedInput,
                    preferredOutput = externalOutput
                ) ?: target
                applyAudioModuleInputDevice(appliedInput)
                return rememberAppliedAudioRoute(
                    externalOutput ?: fallbackOutputDevice(routeOutputs),
                    appliedInput
                )
            }
        }

        val outputs = sortedCallRoutes(outputDevices(manager))
        val external = automaticExternalOutput(
            devices = outputs,
            shouldRecord = shouldRecord,
            hasCaptureInput = !shouldRecord || inputDevices(manager).isNotEmpty()
        )
        @Suppress("DEPRECATION")
        setSpeakerphoneEnabled(manager, external == null)
        setBluetoothScoEnabled(manager, external?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        val appliedInput = bestCaptureInput(
            manager = manager,
            routeDevices = outputs,
            selectedInputId = selectedInput,
            preferredOutput = external
        )
        applyAudioModuleInputDevice(appliedInput)
        return rememberAppliedAudioRoute(external ?: fallbackOutputDevice(outputs), appliedInput)
    }

    private fun normalizeSelectedAudioRouteIds(manager: AudioManager) {
        val selectedInput = selectedAudioInputDeviceId
        if (!selectedInput.isNullOrBlank()) {
            val inputs = inputDevices(manager)
            if (inputs.none { audioDeviceIdMatches(selectedInput, it, AudioDeviceSelectionDirection.input) } &&
                !isPermissionHiddenBluetoothRoute(manager, selectedInput)
            ) {
                selectedAudioInputDeviceId = null
            }
        }

        val selectedOutput = selectedAudioOutputDeviceId
        if (!selectedOutput.isNullOrBlank()) {
            val outputs = outputDevices(manager)
            if (outputs.none { audioDeviceIdMatches(selectedOutput, it, AudioDeviceSelectionDirection.output) } &&
                !isPermissionHiddenBluetoothRoute(manager, selectedOutput)
            ) {
                selectedAudioOutputDeviceId = null
            }
        }
    }

    internal fun activateCallAudioSession() {
        configureCallAudioMode(unmuted = shouldLocalAudioCaptureStayActive())
    }

    @Suppress("DEPRECATION")
    private fun setSpeakerphoneEnabled(manager: AudioManager, enabled: Boolean) {
        try {
            if (manager.isSpeakerphoneOn == enabled) return
            manager.isSpeakerphoneOn = enabled
        } catch (_: Throwable) {
        }
    }

    private fun setBluetoothScoEnabled(manager: AudioManager, enabled: Boolean) {
        @Suppress("DEPRECATION")
        try {
            if (manager.isBluetoothScoOn == enabled) return
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
        val manager = audioManager() ?: return skip.lib.Array()
        val out = mutableListOf<AudioDevice>()
        val seenIds = mutableSetOf<String>()
        val labelCounts = mutableMapOf<String, Int>()
        for (info in inputDevices(manager)) {
            appendAudioDeviceOption(info, AudioDeviceSelectionDirection.input, out, seenIds, labelCounts)
        }
        return skip.lib.Array(out)
    }

    internal fun availableAudioOutputs(): skip.lib.Array<AudioDevice> {
        val manager = audioManager() ?: return skip.lib.Array()
        val out = mutableListOf<AudioDevice>()
        val seenIds = mutableSetOf<String>()
        val labelCounts = mutableMapOf<String, Int>()
        val routeDevices = outputDevices(manager)
        for (info in sortedCallRoutes(routeDevices)) {
            // Telephony / aux / unknown sinks aren't useful pick targets.
            if (info.type == AudioDeviceInfo.TYPE_TELEPHONY) {
                continue
            }
            appendAudioDeviceOption(info, AudioDeviceSelectionDirection.output, out, seenIds, labelCounts)
        }
        return skip.lib.Array(out)
    }

    private fun appendAudioDeviceOption(
        info: AudioDeviceInfo,
        direction: AudioDeviceSelectionDirection,
        out: MutableList<AudioDevice>,
        seenIds: MutableSet<String>,
        labelCounts: MutableMap<String, Int>
    ) {
        val id = audioDeviceSelectionId(info, direction)
        if (!seenIds.add(id)) return

        val baseLabel = deviceLabel(info)
        val count = (labelCounts[baseLabel] ?: 0) + 1
        labelCounts[baseLabel] = count
        val label = if (count == 1) baseLabel else "$baseLabel $count"
        out.add(AudioDevice(id = id, label = label))
    }

    internal fun currentAudioInputId(): String? {
        val manager = audioManager() ?: return null
        val selected = selectedAudioInputDeviceId
        val inputs = inputDevices(manager)
        if (!selected.isNullOrBlank() && inputs.any { audioDeviceIdMatches(selected, it, AudioDeviceSelectionDirection.input) }) {
            return selected
        }
        val routeDevices = callRouteDevices(manager)
        val activeOutput = currentCommunicationDevice(manager)
        val inferredInput = bestCaptureInput(
            manager = manager,
            routeDevices = routeDevices,
            selectedInputId = null,
            preferredOutput = activeOutput
        )
        return inferredInput
            ?.takeIf { input -> inputs.any { it.id == input.id && it.type == input.type } }
            ?.id
            ?.toString()
            ?.let { "in:$it" }
    }

    internal fun currentAudioOutputId(): String? {
        val manager = audioManager() ?: return null
        val selected = selectedAudioOutputDeviceId
        if (Build.VERSION.SDK_INT >= 31) {
            val outputs = outputDevices(manager)
            if (!selected.isNullOrBlank() && outputs.any { audioDeviceIdMatches(selected, it, AudioDeviceSelectionDirection.output) }) {
                return selected
            }
            currentCommunicationDevice(manager)
                ?.takeIf { current -> outputs.any { it.id == current.id } }
                ?.let { return audioDeviceSelectionId(it, AudioDeviceSelectionDirection.output) }
            return sortedCallRoutes(outputs).firstOrNull { isExternalCallRoute(it) }
                ?.let { audioDeviceSelectionId(it, AudioDeviceSelectionDirection.output) }
                ?: outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ?.let { audioDeviceSelectionId(it, AudioDeviceSelectionDirection.output) }
                ?: outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    ?.let { audioDeviceSelectionId(it, AudioDeviceSelectionDirection.output) }
        }
        // Pre-31: speaker vs earpiece is the only thing we can read back.
        if (!selected.isNullOrBlank()) {
            val outputs = outputDevices(manager)
            if (outputs.any { audioDeviceIdMatches(selected, it, AudioDeviceSelectionDirection.output) }) {
                return selected
            }
        }
        val speakerOn = manager.isSpeakerphoneOn
        val devices = outputDevices(manager)
        val wanted = if (speakerOn) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        return devices.firstOrNull { it.type == wanted }
            ?.let { audioDeviceSelectionId(it, AudioDeviceSelectionDirection.output) }
    }

    internal fun selectAudioInput(deviceId: String) {
        val manager = audioManager() ?: return
        val trimmed = deviceId.trim()
        selectedAudioInputDeviceId = if (trimmed.isEmpty()) {
            null
        } else {
            val isSelectable = inputDevices(manager).any {
                audioDeviceIdMatches(trimmed, it, AudioDeviceSelectionDirection.input)
            }
            if (!isSelectable && !isPermissionHiddenBluetoothRoute(manager, trimmed)) {
                debugLog("[WebRTC] Ignoring unavailable audio input route: $trimmed")
                return
            }
            trimmed
        }
        ensureCommunicationMode(manager)
        if (selectedRouteNeedsBluetoothConnectPermission(manager)) {
            val routeChanged = applyPreferredCommunicationRoute(manager)
            reassertCallAudioCaptureIfActive(manager)
            restartLocalAudioTrackAfterRouteChange(routeChanged && shouldLocalAudioCaptureStayActive(), "audio input selection")
            notifyCallAudioRouteChanged()
            requestBluetoothConnectPermissionThenReapplyRoute()
            return
        }
        val routeChanged = applyPreferredCommunicationRoute(manager)
        reassertCallAudioCaptureIfActive(manager)
        restartLocalAudioTrackAfterRouteChange(routeChanged && shouldLocalAudioCaptureStayActive(), "audio input selection")
        notifyCallAudioRouteChanged()
    }

    internal fun selectAudioOutput(deviceId: String) {
        val manager = audioManager() ?: return
        val trimmed = deviceId.trim()
        selectedAudioOutputDeviceId = if (trimmed.isEmpty()) {
            null
        } else {
            val isSelectable = outputDevices(manager).any {
                audioDeviceIdMatches(trimmed, it, AudioDeviceSelectionDirection.output)
            }
            if (!isSelectable && !isPermissionHiddenBluetoothRoute(manager, trimmed)) {
                debugLog("[WebRTC] Ignoring unavailable audio output route: $trimmed")
                return
            }
            trimmed
        }
        // Audio routing only takes effect while the session is in communication
        // mode (the call mode). Set it defensively; the WebRTC ADM also uses it.
        ensureCommunicationMode(manager)

        if (selectedRouteNeedsBluetoothConnectPermission(manager)) {
            val routeChanged = applyPreferredCommunicationRoute(manager)
            reassertCallAudioCaptureIfActive(manager)
            restartLocalAudioTrackAfterRouteChange(routeChanged && shouldLocalAudioCaptureStayActive(), "audio output selection")
            notifyCallAudioRouteChanged()
            requestBluetoothConnectPermissionThenReapplyRoute()
            return
        }

        if (trimmed.isBlank()) {
            val routeChanged = applyPreferredCommunicationRoute(manager)
            reassertCallAudioCaptureIfActive(manager)
            restartLocalAudioTrackAfterRouteChange(routeChanged && shouldLocalAudioCaptureStayActive(), "audio output selection")
            notifyCallAudioRouteChanged()
            return
        }

        // API 31+ and legacy devices both go through the unified path so output
        // changes also re-apply the preferred microphone input.
        val routeChanged = applyPreferredCommunicationRoute(manager)
        reassertCallAudioCaptureIfActive(manager)
        restartLocalAudioTrackAfterRouteChange(routeChanged && shouldLocalAudioCaptureStayActive(), "audio output selection")
        notifyCallAudioRouteChanged()
    }

    private fun requestBluetoothConnectPermissionThenReapplyRoute() {
        if (bluetoothConnectPermissionRequestToken != null) {
            return
        }
        var completedSynchronously = false
        val token = PermissionHelper.requestBluetoothConnectPermission { granted ->
            completedSynchronously = true
            bluetoothConnectPermissionRequestToken = null
            reapplyCallAudioRoute(forceCaptureRestart = false)
        }
        bluetoothConnectPermissionRequestToken = if (completedSynchronously) null else token
    }

    // Plays a short DTMF/beep through the active output so the user can confirm
    // the selected speaker is audible (mirrors web's "Test speaker").
    internal fun testSpeaker() {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
            // Release after the tone finishes so the generator isn't leaked.
            mainHandler.postDelayed({
                tone.release()
            }, 400L)
        } catch (_: Throwable) {
        }
    }

    private val outgoingBandwidthFairBps = 500_000.0
    private val outgoingBandwidthPoorBps = 240_000.0
    private val outgoingBandwidthEmergencyBps = 120_000.0
    private val screenShareOutgoingFairBps = 1_500_000.0
    private val screenShareOutgoingPoorBps = 550_000.0
    private val screenShareOutgoingEmergencyBps = 280_000.0
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
                screenSharePublishQuality = ConnectionQuality.unknown,
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
        val screenSharePublishQuality = deriveScreenSharePublishQuality(
            availableBitrate = publish.availableBitrate,
            emergencyMode = publishQuality == ConnectionQuality.emergency,
        )
        return ConnectionQualitySample(
            publishQuality = publishQuality,
            receiveQuality = receiveQuality,
            overallQuality = worstConnectionQuality(publishQuality, receiveQuality),
            screenSharePublishQuality = screenSharePublishQuality,
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

    private fun deriveScreenSharePublishQuality(
        availableBitrate: Double?,
        emergencyMode: Boolean,
    ): ConnectionQuality {
        if (emergencyMode) return ConnectionQuality.emergency
        val bitrate = availableBitrate ?: return ConnectionQuality.unknown
        if (bitrate <= 0.0 || bitrate.isNaN() || bitrate.isInfinite()) {
            return ConnectionQuality.unknown
        }
        if (bitrate <= screenShareOutgoingEmergencyBps) {
            return ConnectionQuality.emergency
        }
        if (bitrate <= screenShareOutgoingPoorBps) {
            return ConnectionQuality.poor
        }
        if (bitrate <= screenShareOutgoingFairBps) {
            return ConnectionQuality.fair
        }
        return ConnectionQuality.good
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
            if (info.kind != "audio") {
                continue
            }
            val statsJson = try {
                info.consumer.getStats()
            } catch (_: Throwable) {
                continue
            }
            val level = parseInboundAudioLevel(statsJson) ?: continue
            val existing = levels[info.userId] ?: 0.0
            levels[info.userId] = maxOf(existing, level)
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

    // Video freeze watchdog - mirrors iOS checkVideoFreezes (and the web one):
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
                // Still frozen - request a keyframe. Do NOT reset the stall
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
            if (targetUserId != null && !consumerMatchesVideoRefreshTarget(info, targetUserId)) {
                continue
            }
            videoFreezeStats.remove(consumerId)
            try {
                socket.resumeConsumer(consumerId, true)
            } catch (_: Throwable) {
            }
        }
    }

    private fun consumerMatchesVideoRefreshTarget(info: ConsumerInfo, targetUserId: String): Boolean {
        if (info.userId == targetUserId || info.trackKey == targetUserId) return true

        val screenSuffix = "-${ProducerType.screen.rawValue}"
        val targetWantsScreen = targetUserId.endsWith(screenSuffix)
        val targetKey = stableRemoteTrackUserKey(
            targetUserId,
            removeScreenSuffix = targetWantsScreen
        )
        if (targetKey.isEmpty()) return false

        return listOf(info.userId, info.trackKey).any { candidate ->
            val normalized = candidate.trim()
            val candidateIsScreenTrack = normalized.endsWith(screenSuffix)
            if (normalized.isEmpty()) {
                false
            } else if (candidateIsScreenTrack != targetWantsScreen) {
                false
            } else {
                stableRemoteTrackUserKey(
                    normalized,
                    removeScreenSuffix = candidateIsScreenTrack
                ) == targetKey
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
            audioCaptureReassertionGeneration += 1
            recoverCallAudioAfterAdmError("microphone producer transport close", recoverCapture = true)
            onLocalAudioProducerLost?.invoke()
        } else if (producer.id == videoProducer?.id) {
            videoProducer = null
            videoProducerBandwidthQuality = ConnectionQuality.unknown
            videoProducerBandwidthSignature = null
            localVideoEnabled = false
            onLocalVideoProducerLost?.invoke()
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

    private fun ensureAndroidMediaStack(context: Context) {
        synchronized(mediaStackLock) {
            if (!mediasoupInitialized) {
                MediasoupClient.initialize(context)
                mediasoupInitialized = true
            }
            ensurePeerConnectionFactoryLocked(context)
        }
    }

    private fun ensurePeerConnectionFactory(context: Context) {
        if (peerConnectionFactory != null) return
        synchronized(mediaStackLock) {
            ensurePeerConnectionFactoryLocked(context)
        }
    }

    private fun ensurePeerConnectionFactoryLocked(context: Context) {
        if (peerConnectionFactory != null) return
        val options = PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()
        PeerConnectionFactory.initialize(options)

        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        val audioModule = JavaAudioDeviceModule.builder(context)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setUseHardwareAcousticEchoCanceler(JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported())
            .setUseHardwareNoiseSuppressor(JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported())
            .setUseStereoInput(false)
            .setUseStereoOutput(false)
            .setUseLowLatency(true)
            .setAudioRecordErrorCallback(object : JavaAudioDeviceModule.AudioRecordErrorCallback {
                override fun onWebRtcAudioRecordInitError(errorMessage: String) {
                    debugLog("[WebRTC] Audio record init error: ${errorMessage}")
                    recoverCallAudioAfterAdmError("record init error", recoverCapture = true)
                }

                override fun onWebRtcAudioRecordStartError(
                    errorCode: JavaAudioDeviceModule.AudioRecordStartErrorCode,
                    errorMessage: String
                ) {
                    debugLog("[WebRTC] Audio record start error (${errorCode}): ${errorMessage}")
                    recoverCallAudioAfterAdmError("record start error", recoverCapture = true)
                }

                override fun onWebRtcAudioRecordError(errorMessage: String) {
                    debugLog("[WebRTC] Audio record error: ${errorMessage}")
                    recoverCallAudioAfterAdmError("record error", recoverCapture = true)
                }
            })
            .setAudioTrackErrorCallback(object : JavaAudioDeviceModule.AudioTrackErrorCallback {
                override fun onWebRtcAudioTrackInitError(errorMessage: String) {
                    debugLog("[WebRTC] Audio playout init error: ${errorMessage}")
                    recoverCallAudioAfterAdmError("playout init error", recoverCapture = false)
                }

                override fun onWebRtcAudioTrackStartError(
                    errorCode: JavaAudioDeviceModule.AudioTrackStartErrorCode,
                    errorMessage: String
                ) {
                    debugLog("[WebRTC] Audio playout start error (${errorCode}): ${errorMessage}")
                    recoverCallAudioAfterAdmError("playout start error", recoverCapture = false)
                }

                override fun onWebRtcAudioTrackError(errorMessage: String) {
                    debugLog("[WebRTC] Audio playout error: ${errorMessage}")
                    recoverCallAudioAfterAdmError("playout error", recoverCapture = false)
                }
            })
            .createAudioDeviceModule()
        audioDeviceModule = audioModule
        peerConnectionFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    internal fun canSwitchCamera(): Boolean {
        val enumerator = createCameraEnumerator(ProcessInfo.processInfo.androidContext)
        return cameraNameForFacing(enumerator, LocalCameraFacing.front) != null &&
            cameraNameForFacing(enumerator, LocalCameraFacing.back) != null
    }

    internal fun setPreferredCameraFacing(facing: LocalCameraFacing) {
        if (localVideoEnabled && videoCapturer != null) return
        val enumerator = createCameraEnumerator(ProcessInfo.processInfo.androidContext)
        if (cameraNameForFacing(enumerator, facing) == null) return
        activeCameraFacing = facing
    }

    internal suspend fun switchCamera() {
        val nextFacing = oppositeCameraFacing(activeCameraFacing)
        val enumerator = createCameraEnumerator(ProcessInfo.processInfo.androidContext)
        if (cameraNameForFacing(enumerator, nextFacing) == null) {
            throw ErrorException("No ${cameraFacingLabel(nextFacing).lowercase()} available")
        }

        val previousFacing = activeCameraFacing
        activeCameraFacing = nextFacing

        val capturer = videoCapturer
        if (!localVideoEnabled || capturer == null) {
            return
        }
        if (capturer !is CameraVideoCapturer) {
            activeCameraFacing = previousFacing
            throw ErrorException("Camera switch unavailable")
        }

        return suspendCancellableCoroutine { cont ->
            capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
                override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                    activeCameraFacing = if (isFrontCamera) LocalCameraFacing.front else LocalCameraFacing.back
                    if (cont.isActive) {
                        cont.resume(Unit)
                    }
                }

                override fun onCameraSwitchError(errorDescription: String?) {
                    activeCameraFacing = previousFacing
                    if (cont.isActive) {
                        cont.resumeWithException(
                            ErrorException(errorDescription ?: "Camera switch failed")
                        )
                    }
                }
            })
        }
    }

    private fun createCameraEnumerator(context: Context): org.webrtc.CameraEnumerator {
        return if (Camera2Enumerator.isSupported(context)) {
            Camera2Enumerator(context)
        } else {
            Camera1Enumerator(true)
        }
    }

    private fun cameraNameForFacing(
        enumerator: org.webrtc.CameraEnumerator,
        facing: LocalCameraFacing
    ): String? {
        val deviceNames = enumerator.deviceNames
        return when (facing) {
            LocalCameraFacing.front -> deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            LocalCameraFacing.back -> deviceNames.firstOrNull { enumerator.isBackFacing(it) }
        }
    }

    private fun oppositeCameraFacing(facing: LocalCameraFacing): LocalCameraFacing {
        return when (facing) {
            LocalCameraFacing.front -> LocalCameraFacing.back
            LocalCameraFacing.back -> LocalCameraFacing.front
        }
    }

    private fun cameraFacingLabel(facing: LocalCameraFacing): String {
        return when (facing) {
            LocalCameraFacing.front -> "Front camera"
            LocalCameraFacing.back -> "Rear camera"
        }
    }

    private fun createCameraCapturer(context: Context): VideoCapturer? {
        val enumerator = createCameraEnumerator(context)
        val preferredFacing = activeCameraFacing
        val fallbackFacing = oppositeCameraFacing(preferredFacing)
        val preferredName = cameraNameForFacing(enumerator, preferredFacing)
        val fallbackName = cameraNameForFacing(enumerator, fallbackFacing)
        val selectedFacing = if (preferredName != null) preferredFacing else fallbackFacing
        val selectedName = preferredName ?: fallbackName ?: return null

        activeCameraFacing = selectedFacing
        return enumerator.createCapturer(selectedName, null)
    }

    private fun startWebcamCapture(capturer: VideoCapturer?, action: String) {
        val activeCapturer = capturer ?: throw ErrorException("Camera capturer unavailable")
        val profile = webcamCaptureProfile(currentVideoQuality, currentLocalBandwidthQuality)
        if (isWebcamCaptureActive) {
            try {
                activeCapturer.changeCaptureFormat(profile.width, profile.height, profile.fps)
                return
            } catch (error: Throwable) {
                debugLog("[WebRTC] Failed to update active camera capture format before $action: ${error}")
                stopWebcamCapture()
            }
        }
        try {
            activeCapturer.startCapture(profile.width, profile.height, profile.fps)
            isWebcamCaptureActive = true
        } catch (error: Throwable) {
            stopWebcamCapture()
            try {
                activeCapturer.startCapture(profile.width, profile.height, profile.fps)
                isWebcamCaptureActive = true
            } catch (retryError: Throwable) {
                val detail = retryError.localizedMessage ?: retryError.toString()
                throw ErrorException("Camera capture failed to $action: $detail")
            }
        }
    }

    private fun stopWebcamCapture() {
        val capturer = videoCapturer ?: run {
            isWebcamCaptureActive = false
            return
        }
        try {
            capturer.stopCapture()
        } catch (_: Throwable) {
        } finally {
            isWebcamCaptureActive = false
        }
    }

    private suspend fun releasePreJoinCameraPreview() {
        withContext(Dispatchers.Main.immediate) {
            CameraPreviewController.releasePreview()
        }
        delay(PRE_JOIN_CAMERA_RELEASE_SETTLE_MS)
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
