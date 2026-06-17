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
    private var serverRtpCapabilities: RtpCapabilities? = null

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

            val key = if (info.trackKey.isEmpty()) info.userId else info.trackKey
            if (key.isNotEmpty()) {
                remoteVideoTracks.removeValue(forKey = key)
            }
        }
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
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        if (!ensureRecordAudioPermission()) {
            throw ErrorException("Microphone permission not granted")
        }

        if (audioSource == null) {
            audioSource = peerConnectionFactory?.createAudioSource(MediaConstraints())
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
            val producer = sendTransport.produce(this, audioTrack as MediaStreamTrack, null, null, null, appData)
            pendingProducer = producer
            producer.resume()

            audioProducer = producer
            localAudioEnabled = true
            onLocalAudioEnabledChanged?.invoke(true)
        } catch (t: Throwable) {
            pendingProducer?.close()
            localAudioTrack?.setEnabled(false)
            localAudioTrack = null
            clearAudioSource()
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
            capturer.startCapture(1280, 720, 30)

            localVideoTrack = peerConnectionFactory?.createVideoTrack("video0", source)
            val videoTrack = localVideoTrack ?: throw ErrorException("Video track unavailable")
            videoTrack.setEnabled(true)

            val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
            // codec=null in the 6-arg slot — see startProducingAudio.
            val producer = sendTransport.produce(this, videoTrack as MediaStreamTrack, null, null, null, appData)
            pendingProducer = producer
            producer.resume()

            videoProducer = producer
            localVideoEnabled = true
            onLocalVideoEnabledChanged?.invoke(true)

            val wrapper = VideoTrackWrapper(id = producer.id, userId = "local", isLocal = true, track = videoTrack)
            localVideoTrackWrapper = wrapper
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
            // getMediaProjection() + createVirtualDisplay() happen here. If the
            // typed FGS isn't live, or the consent token was already consumed,
            // this throws SecurityException. Tear down the half-built capture
            // chain so a retry starts clean (no leaked SurfaceTextureHelper /
            // capturer) and rethrow for the VM's catch to surface the error.
            capturer.startCapture(metrics.widthPixels, metrics.heightPixels, 30)

            val track = peerConnectionFactory?.createVideoTrack("screen0", source)
                ?: throw ErrorException("Screen track unavailable")
            track.setEnabled(true)
            screenVideoTrack = track

            val appData = encodeJSONString(ProducerAppData(type = ProducerType.screen.rawValue, paused = false))
            // codec=null in the 6-arg slot — see startProducingAudio.
            val producer = sendTransport.produce(this, track as MediaStreamTrack, null, null, null, appData)
            pendingProducer = producer
            producer.resume()
            screenProducer = producer
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

    internal suspend fun consumeProducer(producerId: String, producerUserId: String, producerType: String = "webcam") {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val rtpCapsJson = socket.routerRtpCapabilitiesJson ?: throw ErrorException("RTP caps missing")
        val receiveTransport = receiveTransport ?: throw ErrorException("Receive transport missing")
        val receiveTransportId = receiveTransportId ?: throw ErrorException("Receive transport ID missing")

        // Raw-JSON path: send the router caps verbatim and feed the server's
        // rtpParameters straight into mediasoup, never touching the Codable
        // structs that Skip's JSONEncoder can't round-trip.
        val response = socket.consumeRaw(producerId, rtpCapsJson, receiveTransportId)
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
            }
        } else {
            val entry = consumers.entries.firstOrNull { it.value.producerId == producerId }
            if (entry != null) {
                entry.value.consumer.close()
                consumers.remove(entry.key)
                videoFreezeStats.remove(entry.key)
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
                videoCapturer?.startCapture(1280, 720, 30)
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

    internal fun updateVideoQuality(quality: VideoQuality) {
        val producer = videoProducer ?: return
        val layer = if (quality == VideoQuality.low) 0 else 1
        try {
            producer.setMaxSpatialLayer(layer)
        } catch (_: Throwable) {
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

        consumers.values.forEach { it.consumer.close() }
        consumers.clear()
        videoFreezeStats.clear()
        previousConnectionLossSample = null

        localVideoTrack?.setEnabled(false)
        localAudioTrack?.setEnabled(false)
        localVideoTrack = null
        localAudioTrack = null
        clearVideoSource()
        clearAudioSource()

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

    internal fun availableAudioInputs(): skip.lib.Array<AudioDevice> {
        val manager = audioManager() ?: return skip.lib.Array()
        val out = mutableListOf<AudioDevice>()
        val seen = mutableSetOf<String>()
        for (info in manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            val label = deviceLabel(info)
            if (seen.add(label)) {
                out.add(AudioDevice(id = info.id.toString(), label = label))
            }
        }
        return skip.lib.Array(out)
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
        val manager = audioManager() ?: return null
        if (Build.VERSION.SDK_INT >= 31) {
            val device = manager.communicationDevice ?: return null
            return device.id.toString()
        }
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
        // Routing the communication device (API 31+) sets both the active input
        // and output for the accessory; the dedicated output picker covers the
        // rest. On older OS versions input routing isn't independently selectable.
        if (Build.VERSION.SDK_INT >= 31) {
            routeCommunicationDevice(deviceId)
        }
    }

    internal fun selectAudioOutput(deviceId: String) {
        val manager = audioManager() ?: return
        // Audio routing only takes effect while the session is in communication
        // mode (the call mode). Set it defensively; the WebRTC ADM also uses it.
        manager.mode = AudioManager.MODE_IN_COMMUNICATION

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

    private data class ConnectionLossSample(
        val packetsLost: Double,
        val packetsReceived: Double,
    )

    private data class ConnectionStatsSample(
        val rttMs: Double?,
        val jitterMs: Double?,
        val packetsLost: Double,
        val packetsReceived: Double,
    )

    private var previousConnectionLossSample: ConnectionLossSample? = null

    internal fun sampleConnectionQuality(): ConnectionQuality {
        val liveTransports = listOfNotNull(sendTransport, receiveTransport)
            .filter { transport -> !transport.isClosed }
        if (liveTransports.isEmpty()) {
            previousConnectionLossSample = null
            return ConnectionQuality.unknown
        }

        var rttMs: Double? = null
        var jitterMs: Double? = null
        var packetsLost = 0.0
        var packetsReceived = 0.0
        var foundStats = false

        for (transport in liveTransports) {
            val statsJson = try {
                transport.getStats()
            } catch (_: Throwable) {
                continue
            }
            val sample = parseConnectionStats(statsJson) ?: continue
            foundStats = true
            sample.rttMs?.let { value -> rttMs = maxNullable(rttMs, value) }
            sample.jitterMs?.let { value -> jitterMs = maxNullable(jitterMs, value) }
            packetsLost += sample.packetsLost
            packetsReceived += sample.packetsReceived
        }

        if (!foundStats) {
            previousConnectionLossSample = null
            return ConnectionQuality.unknown
        }

        var packetLoss: Double? = null
        val previous = previousConnectionLossSample
        if (previous != null) {
            val deltaLost = kotlin.math.max(0.0, packetsLost - previous.packetsLost)
            val deltaReceived = kotlin.math.max(0.0, packetsReceived - previous.packetsReceived)
            val deltaTotal = deltaLost + deltaReceived
            packetLoss = if (deltaTotal > 0.0) deltaLost / deltaTotal else 0.0
        }
        previousConnectionLossSample = ConnectionLossSample(packetsLost, packetsReceived)

        return deriveConnectionQuality(rttMs, packetLoss, jitterMs)
    }

    private fun parseConnectionStats(statsJson: String): ConnectionStatsSample? {
        val array = try {
            JSONArray(statsJson)
        } catch (_: Throwable) {
            return null
        }

        var rttMs: Double? = null
        var candidatePairRttMs: Double? = null
        var jitterMs: Double? = null
        var packetsLost = 0.0
        var packetsReceived = 0.0
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
                }
                "inbound-rtp" -> {
                    jsonNumber(obj, "jitter")?.let { value ->
                        jitterMs = maxNullable(jitterMs, value * 1000.0)
                        foundMetric = true
                    }
                    jsonNumber(obj, "packetsLost")?.let { value ->
                        packetsLost += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                    jsonNumber(obj, "packetsReceived")?.let { value ->
                        packetsReceived += kotlin.math.max(0.0, value)
                        foundMetric = true
                    }
                }
                "remote-inbound-rtp" -> {
                    jsonNumber(obj, "roundTripTime")?.let { value ->
                        rttMs = maxNullable(rttMs, value * 1000.0)
                        foundMetric = true
                    }
                    jsonNumber(obj, "jitter")?.let { value ->
                        jitterMs = maxNullable(jitterMs, value * 1000.0)
                        foundMetric = true
                    }
                }
            }
        }

        candidatePairRttMs?.let { value ->
            rttMs = maxNullable(rttMs, value)
        }

        if (!foundMetric) return null
        return ConnectionStatsSample(rttMs, jitterMs, packetsLost, packetsReceived)
    }

    private fun jsonNumber(obj: org.json.JSONObject, key: String): Double? {
        if (!obj.has(key)) return null
        val value = obj.optDouble(key, Double.NaN)
        return if (!value.isNaN() && !value.isInfinite()) value else null
    }

    private fun maxNullable(current: Double?, next: Double): Double {
        return if (current == null) next else kotlin.math.max(current, next)
    }

    private fun deriveConnectionQuality(
        rttMs: Double?,
        packetLoss: Double?,
        jitterMs: Double?,
    ): ConnectionQuality {
        if (rttMs == null && packetLoss == null && jitterMs == null) {
            return ConnectionQuality.unknown
        }
        if ((rttMs ?: 0.0) >= 500.0 ||
            (packetLoss ?: 0.0) >= 0.08 ||
            (jitterMs ?: 0.0) >= 60.0) {
            return ConnectionQuality.poor
        }
        if ((rttMs ?: 0.0) >= 250.0 ||
            (packetLoss ?: 0.0) >= 0.03 ||
            (jitterMs ?: 0.0) >= 30.0) {
            return ConnectionQuality.fair
        }
        return ConnectionQuality.good
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
            if (!active.contains(key)) videoFreezeStats.remove(key)
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
            localAudioEnabled = false
            onLocalAudioEnabledChanged?.invoke(false)
        } else if (producer.id == videoProducer?.id) {
            videoProducer = null
            localVideoEnabled = false
            onLocalVideoEnabledChanged?.invoke(false)
        } else if (producer.id == screenProducer?.id) {
            screenProducer = null
        }
    }

    override fun onTransportClose(consumer: Consumer) {
        val entry = consumers.entries.firstOrNull { it.value.consumer.id == consumer.id } ?: return
        consumers.remove(entry.key)
        videoFreezeStats.remove(entry.key)
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
