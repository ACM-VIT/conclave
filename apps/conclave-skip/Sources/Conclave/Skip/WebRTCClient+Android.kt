package conclave.module

import android.content.Context
import org.mediasoup.droid.Consumer
import org.mediasoup.droid.Device
import org.mediasoup.droid.MediasoupClient
import org.mediasoup.droid.Producer
import org.mediasoup.droid.RecvTransport
import org.mediasoup.droid.SendTransport
import org.mediasoup.droid.Transport
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnectionFactory
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
    private var sendTransport: SendTransport? = null
    private var receiveTransport: RecvTransport? = null
    private var sendTransportId: String? = null
    private var receiveTransportId: String? = null

    private var audioProducer: Producer? = null
    private var videoProducer: Producer? = null
    private var screenProducer: Producer? = null

    private data class ConsumerInfo(
        val consumer: Consumer,
        val producerId: String,
        val userId: String,
        val kind: String
    )

    private val consumers: MutableMap<String, ConsumerInfo> = mutableMapOf()
    private var serverRtpCapabilities: RtpCapabilities? = null
    private var socketManager: SocketIOManager? = null

    private var peerConnectionFactory: PeerConnectionFactory? = null
    private val eglBase: EglBase = EglBase.create()
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoCapturer: VideoCapturer? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null

    internal fun configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities) {
        this.socketManager = socketManager
        this.serverRtpCapabilities = rtpCapabilities

        val context = ProcessInfo.processInfo.androidContext
        MediasoupClient.initialize(context)
        ensurePeerConnectionFactory(context)

        val device = Device()
        val capabilities = encodeJSONString(rtpCapabilities)
        try {
            device.load(capabilities, null)
        } catch (error: Throwable) {
            debugLog("[WebRTC] Failed to load device capabilities: ${error}")
        }
        this.device = device
    }

    internal suspend fun createTransports() {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val device = device ?: throw ErrorException("Device not configured")

        val producerTransportParams = socket.createProducerTransport()
        val consumerTransportParams = socket.createConsumerTransport()

        sendTransportId = producerTransportParams.id
        receiveTransportId = consumerTransportParams.id

        sendTransport = device.createSendTransport(
            this,
            producerTransportParams.id,
            encodeJSONString(producerTransportParams.iceParameters),
            encodeJSONString(producerTransportParams.iceCandidates),
            encodeJSONString(producerTransportParams.dtlsParameters)
        )

        receiveTransport = device.createRecvTransport(
            this,
            consumerTransportParams.id,
            encodeJSONString(consumerTransportParams.iceParameters),
            encodeJSONString(consumerTransportParams.iceCandidates),
            encodeJSONString(consumerTransportParams.dtlsParameters)
        )
    }

    internal suspend fun startProducingAudio() {
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        if (audioSource == null) {
            audioSource = peerConnectionFactory?.createAudioSource(MediaConstraints())
        }

        localAudioTrack = peerConnectionFactory?.createAudioTrack("audio0", audioSource)
        val audioTrack = localAudioTrack ?: throw ErrorException("Audio track unavailable")
        audioTrack.setEnabled(true)

        val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
        val producer = sendTransport.produce(this, audioTrack as MediaStreamTrack, null, null, appData)
        producer.resume()

        audioProducer = producer
        localAudioEnabled = true
        onLocalAudioEnabledChanged?.invoke(true)
    }

    internal suspend fun startProducingVideo() {
        val sendTransport = sendTransport ?: throw ErrorException("Send transport not ready")
        ensurePeerConnectionFactory(ProcessInfo.processInfo.androidContext)

        if (videoCapturer == null) {
            videoCapturer = createCameraCapturer(ProcessInfo.processInfo.androidContext)
        }

        if (surfaceTextureHelper == null) {
            surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
        }

        val capturer = videoCapturer ?: throw ErrorException("No camera capturer")
        videoSource = peerConnectionFactory?.createVideoSource(false)
        val source = videoSource ?: throw ErrorException("Video source unavailable")
        capturer.initialize(surfaceTextureHelper, ProcessInfo.processInfo.androidContext, source.capturerObserver)
        capturer.startCapture(1280, 720, 30)

        localVideoTrack = peerConnectionFactory?.createVideoTrack("video0", source)
        val videoTrack = localVideoTrack ?: throw ErrorException("Video track unavailable")
        videoTrack.setEnabled(true)

        val appData = encodeJSONString(ProducerAppData(type = ProducerType.webcam.rawValue, paused = false))
        val producer = sendTransport.produce(this, videoTrack as MediaStreamTrack, null, null, appData)
        producer.resume()

        videoProducer = producer
        localVideoEnabled = true
        onLocalVideoEnabledChanged?.invoke(true)

        val wrapper = VideoTrackWrapper(id = producer.id, userId = "local", isLocal = true, track = videoTrack)
        localVideoTrackWrapper = wrapper
    }

    internal suspend fun consumeProducer(producerId: String, producerUserId: String) {
        val socket = socketManager ?: throw ErrorException("Socket not configured")
        val rtpCaps = serverRtpCapabilities ?: throw ErrorException("RTP caps missing")
        val receiveTransport = receiveTransport ?: throw ErrorException("Receive transport missing")

        val response = socket.consume(producerId, rtpCaps)
        val consumer = receiveTransport.consume(
            this,
            response.id,
            response.producerId,
            response.kind,
            encodeJSONString(response.rtpParameters)
        )
        consumer.resume()

        consumers[response.id] = ConsumerInfo(
            consumer = consumer,
            producerId = response.producerId,
            userId = producerUserId,
            kind = response.kind
        )

        socket.resumeConsumer(response.id)

        if (response.kind == "video") {
            val track = consumer.track as? VideoTrack
            val wrapper = VideoTrackWrapper(
                id = response.id,
                userId = producerUserId,
                isLocal = false,
                track = track
            )
            remoteVideoTracks[producerUserId] = wrapper
        }
    }

    internal fun closeConsumer(producerId: String, userId: String) {
        if (producerId.isEmpty()) {
            val ids = consumers.filterValues { it.userId == userId }.keys.toList()
            ids.forEach { id ->
                consumers[id]?.consumer?.close()
                consumers.remove(id)
            }
        } else {
            val entry = consumers.entries.firstOrNull { it.value.producerId == producerId }
            if (entry != null) {
                entry.value.consumer.close()
                consumers.remove(entry.key)
                if (entry.value.userId.isNotEmpty()) {
                    remoteVideoTracks.removeValue(forKey = entry.value.userId)
                }
            }
        }

        if (userId.isNotEmpty()) {
            remoteVideoTracks.removeValue(forKey = userId)
        }
    }

    internal suspend fun setAudioEnabled(enabled: Boolean) {
        val socket = socketManager ?: return
        val producer = audioProducer ?: return

        if (enabled) {
            producer.resume()
        } else {
            producer.pause()
        }

        socket.toggleMute(producer.id, paused = !enabled)
        localAudioTrack?.setEnabled(enabled)
        localAudioEnabled = enabled
        onLocalAudioEnabledChanged?.invoke(enabled)
    }

    internal suspend fun setVideoEnabled(enabled: Boolean) {
        val socket = socketManager ?: return
        val producer = videoProducer ?: return

        if (enabled) {
            producer.resume()
        } else {
            producer.pause()
        }

        socket.toggleCamera(producer.id, paused = !enabled)
        localVideoTrack?.setEnabled(enabled)
        localVideoEnabled = enabled
        localVideoTrackWrapper?.isEnabled = enabled

        if (enabled) {
            try {
                videoCapturer?.startCapture(1280, 720, 30)
            } catch (_: Throwable) {
            }
        } else {
            try {
                videoCapturer?.stopCapture()
            } catch (_: Throwable) {
            }
        }

        onLocalVideoEnabledChanged?.invoke(enabled)
    }

    internal fun updateVideoQuality(quality: VideoQuality) {
        val producer = videoProducer ?: return
        val layer = if (quality == VideoQuality.low) 0 else 1
        try {
            producer.setMaxSpatialLayer(layer)
        } catch (_: Throwable) {
        }
    }

    internal suspend fun cleanup() {
        try {
            videoCapturer?.stopCapture()
        } catch (_: Throwable) {
        }
        videoCapturer?.dispose()
        videoCapturer = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null

        audioProducer?.close()
        videoProducer?.close()
        screenProducer?.close()
        audioProducer = null
        videoProducer = null
        screenProducer = null

        consumers.values.forEach { it.consumer.close() }
        consumers.clear()

        localVideoTrack?.setEnabled(false)
        localAudioTrack?.setEnabled(false)
        localVideoTrack = null
        localAudioTrack = null

        localVideoTrackWrapper = null
        remoteVideoTracks.removeAll()

        sendTransport?.close()
        receiveTransport?.close()
        sendTransport = null
        receiveTransport = null
        device?.dispose()
        device = null
    }

    internal fun getCaptureSession(): Any? = null
    internal fun getLocalVideoTrack(): Any? = localVideoTrackWrapper

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
    }

    override fun onProduce(transport: Transport, kind: String, rtpParameters: String, appData: String): String {
        val socket = socketManager ?: return ""
        return runBlocking {
            try {
                val params = decodeJSONString<RtpParameters>(rtpParameters) ?: return@runBlocking ""
                val appDataPayload = decodeJSONString<ProducerAppData>(appData, allowFailure = true)
                val type = ProducerType(rawValue = appDataPayload?.type ?: "webcam") ?: ProducerType.webcam
                socket.produce(
                    transportId = transport.id,
                    kind = kind,
                    rtpParameters = params,
                    type = type,
                    paused = appDataPayload?.paused ?: false
                )
            } catch (_: Throwable) {
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
        if (entry.value.kind == "video") {
            remoteVideoTracks.removeValue(forKey = entry.value.userId)
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

    private fun encodeJSONString(value: Any): String {
        val data = JSONEncoder().encode(value)
        return data.platformValue.toString(Charsets.UTF_8)
    }

    private inline fun <reified T : Any> decodeJSONString(raw: String, allowFailure: Boolean = false): T? {
        val data = Data(platformValue = raw.toByteArray(Charsets.UTF_8))
        return try {
            JSONDecoder().decode(T::class, from = data)
        } catch (error: Throwable) {
            if (allowFailure) null else throw error
        }
    }
}
