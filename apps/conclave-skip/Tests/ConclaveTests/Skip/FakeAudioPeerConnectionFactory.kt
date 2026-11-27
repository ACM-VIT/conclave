package org.webrtc

/**
 * Builds microphone sources and tracks without native WebRTC. Its constructor is package private and checks native
 * initialization, so tests create it with `Unsafe.allocateInstance` and set [makeTrack] afterwards.
 */
class FakeAudioPeerConnectionFactory : PeerConnectionFactory(0L) {
    var makeTrack: (() -> AudioTrack)? = null

    override fun createAudioSource(constraints: MediaConstraints?): AudioSource = AudioSource(0L)

    override fun createAudioTrack(id: String?, source: AudioSource?): AudioTrack =
        makeTrack?.invoke() ?: throw IllegalStateException("No fake audio track")

    var makeVideoSource: (() -> VideoSource)? = null
    var makeVideoTrack: (() -> VideoTrack)? = null

    override fun createVideoSource(isScreencast: Boolean): VideoSource =
        makeVideoSource?.invoke() ?: throw IllegalStateException("No fake video source")

    override fun createVideoTrack(id: String?, source: VideoSource?): VideoTrack =
        makeVideoTrack?.invoke() ?: throw IllegalStateException("No fake video track")
}
