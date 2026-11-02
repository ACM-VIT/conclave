#if os(iOS) && !SKIP
import AVFoundation
import Observation
import SwiftUI
import UIKit

@MainActor
final class ChatClipPlaybackPool {
    private var clips: [String: ChatClipController] = [:]
    private var frames: [String: CGRect] = [:]
    private var active = false
    private var reduceMotion = false
    private var requests: [String] = []

    func register(_ clip: ChatClipController) {
        if let previous = clips[clip.id], previous !== clip { previous.stop() }
        clips[clip.id] = clip
        reconcile()
    }

    func remove(_ clip: ChatClipController) {
        clip.stop()
        if clips[clip.id] === clip {
            clips.removeValue(forKey: clip.id)
            requests.removeAll { $0 == clip.id }
        }
        reconcile()
    }

    func update(frames: [String: CGRect]) {
        self.frames = frames
        reconcile()
    }

    func update(active: Bool, reduceMotion: Bool) {
        self.active = active
        self.reduceMotion = reduceMotion
        if !active { requests = [] }
        reconcile()
    }

    func request(_ id: String) {
        requests.removeAll { $0 == id }
        requests.insert(id, at: 0)
        reconcile()
    }

    private func reconcile() {
        let viewport = frames[ChatClipFrames.viewport] ?? .zero
        let visible = clips.keys.filter { id in
            guard let frame = frames[id], frame.width > 0, frame.height > 0 else { return false }
            let intersection = frame.intersection(viewport)
            return !intersection.isNull && intersection.height >= frame.height * 0.5 && intersection.width > 0
        }.sorted { (frames[$0]?.minY ?? 0) < (frames[$1]?.minY ?? 0) }
        requests.removeAll { !visible.contains($0) }
        let selected = ChatClipPlaybackPolicy.playingIDs(visibleIDs: visible, requestedIDs: requests,
            reduceMotion: reduceMotion, panelOpen: active, appActive: active)
        for (id, clip) in clips where !selected.contains(id) { clip.stop() }
        for id in selected { clips[id]?.play() }
    }
}

struct ChatClipFrames: PreferenceKey {
    static let viewport = "conclave.clip.viewport"
    static var defaultValue: [String: CGRect] { [:] }
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct ChatClipPoolKey: EnvironmentKey {
    static let defaultValue: ChatClipPlaybackPool? = nil
}

extension EnvironmentValues {
    var chatClipPool: ChatClipPlaybackPool? {
        get { self[ChatClipPoolKey.self] }
        set { self[ChatClipPoolKey.self] = newValue }
    }
}

@MainActor @Observable
final class ChatClipController {
    let id: String
    private let url: String
    private(set) var ready = false
    private(set) var playing = false
    private(set) var muted = true
    @ObservationIgnored private var player: AVQueuePlayer?
    @ObservationIgnored private var looper: AVPlayerLooper?
    @ObservationIgnored private weak var surface: ChatClipSurface?
    @ObservationIgnored private var observation: NSKeyValueObservation?

    init(id: String, url: String) {
        self.id = id
        self.url = url
    }

    func attach(_ surface: ChatClipSurface) {
        self.surface = surface
        surface.playerLayer.player = player
        observation = surface.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let ready = self.player != nil && self.surface?.playerLayer.isReadyForDisplay == true
                if self.ready != ready { self.ready = ready }
            }
        }
    }

    func play() {
        guard !playing, let url = URL(string: url) else { return }
        let queue = AVQueuePlayer()
        queue.isMuted = muted || NativeRuntimeConfig.silentAudio
        queue.audiovisualBackgroundPlaybackPolicy = .pauses
        player = queue
        looper = AVPlayerLooper(player: queue, templateItem: AVPlayerItem(url: url))
        surface?.playerLayer.player = queue
        playing = true
        queue.play()
    }

    func toggleMute() {
        muted.toggle()
        player?.isMuted = muted || NativeRuntimeConfig.silentAudio
    }

    func stop() {
        player?.pause()
        surface?.playerLayer.player = nil
        looper?.disableLooping()
        looper = nil
        player?.removeAllItems()
        player = nil
        if playing { playing = false }
        if ready { ready = false }
        if !muted { muted = true }
    }

    func detach() {
        observation?.invalidate()
        observation = nil
        stop()
        surface = nil
    }
}

final class ChatClipSurface: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

private struct ChatClipPlayerLayer: UIViewRepresentable {
    let clip: ChatClipController
    let pool: ChatClipPlaybackPool?

    func makeUIView(context: Context) -> ChatClipSurface {
        let surface = ChatClipSurface()
        surface.playerLayer.videoGravity = .resizeAspect
        surface.isUserInteractionEnabled = false
        clip.attach(surface)
        return surface
    }

    func updateUIView(_ uiView: ChatClipSurface, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(clip: clip, pool: pool) }
    static func dismantleUIView(_ uiView: ChatClipSurface, coordinator: Coordinator) {
        coordinator.pool?.remove(coordinator.clip)
        coordinator.clip.detach()
    }

    final class Coordinator {
        let clip: ChatClipController
        let pool: ChatClipPlaybackPool?
        init(clip: ChatClipController, pool: ChatClipPlaybackPool?) {
            self.clip = clip
            self.pool = pool
        }
    }
}

struct ChatClipAttachment: View {
    let row: ChatRowModel
    @State private var clip: ChatClipController
    @Environment(\.chatClipPool) private var pool
    @Environment(\.displayScale) private var displayScale

    init(row: ChatRowModel) {
        self.row = row
        _clip = State(initialValue: ChatClipController(id: row.id, url: row.gifVideoURL.isEmpty ? row.gifURL : row.gifVideoURL))
    }

    var body: some View {
        let width = CGFloat(ChatMediaGeometry.gifWidth)
        let height = CGFloat(ChatMediaGeometry.gifHeight(aspect: row.gifAspect))
        ZStack {
            Color.black
            ChatClipPlayerLayer(clip: clip, pool: pool)
            if !clip.ready {
                ChatImageBox(url: row.gifPreviewURL.isEmpty ? row.gifURL : row.gifPreviewURL,
                             width: width, height: height, fill: false, cornerRadius: 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            if !clip.playing {
                Button { pool?.request(row.id) } label: {
                    Image(systemName: "play.fill").font(.title3).frame(width: 44, height: 44)
                }
                .accessibilityLabel(ConclaveStrings.text("Play clip"))
                .accessibilityIdentifier("chat.row." + row.id + ".clip.play")
                .modifier(ChatClipButtonStyle(borderWidth: 1 / displayScale))
            }
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button {
                        pool?.request(row.id)
                        clip.toggleMute()
                    } label: {
                        Image(systemName: clip.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.system(size: 14)).frame(width: 36, height: 36)
                    }
                    .accessibilityLabel(ConclaveStrings.text(clip.muted ? "Unmute clip" : "Mute clip"))
                    .accessibilityIdentifier("chat.row." + row.id + ".clip.mute")
                    .modifier(ChatClipButtonStyle(borderWidth: 1 / displayScale))
                }
            }
            .padding(8)
        }
        .frame(width: width, height: height)
        .clipped()
        .task { pool?.register(clip) }
        .background {
            GeometryReader { geometry in
                Color.clear.preference(key: ChatClipFrames.self, value: [row.id: geometry.frame(in: .global)])
            }
        }
    }
}

private struct ChatClipButtonStyle: ViewModifier {
    let borderWidth: CGFloat
    func body(content: Content) -> some View {
        content.buttonStyle(.plain).foregroundStyle(.white)
            .background(Color(white: 0.08), in: Circle())
            .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: borderWidth))
    }
}
#endif
