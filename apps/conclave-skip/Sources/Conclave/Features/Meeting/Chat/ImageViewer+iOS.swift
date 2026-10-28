#if os(iOS) && !SKIP
import ImageIO
import Observation
import SwiftUI
import UIKit

enum ChatMediaCopy {

    static func failureReason(_ failure: ChatFailure) -> String {
        switch failure {
        case .photoTooLarge: return ConclaveStrings.text("Photos can be up to 6 MB.")
        case .photoType: return ConclaveStrings.text("That photo type isn't supported. Use JPEG, PNG, GIF, WebP or AVIF.")
        case .photoUnavailable: return ConclaveStrings.text("Photo upload is unavailable right now.")
        case .photoBlocked:
            return ConclaveStrings.text("Photo not sent. Our safety check flagged it as potentially harmful. Only you can see this notice.")
        case .photoRateLimited: return ConclaveStrings.text("Too many photo uploads. Wait a moment and try again.")
        case .photosDisabled: return ConclaveStrings.text("Photos are turned off by the host.")
        default: return ChatCopy.failureReason(failure)
        }
    }

    static func attachReason(_ reason: String) -> String {
        switch reason {
        case "privateTextOnly": return ConclaveStrings.text("Private messages are text only.")
        case "photosDisabled": return ConclaveStrings.text("Photos are turned off by the host.")
        case "voiceDisabled": return ConclaveStrings.text("Voice messages are turned off by the host.")
        default: return ""
        }
    }

    static func attachmentStatus(_ attachment: ChatAttachmentState) -> String {
        switch attachment.phase {
        case .preparing: return ConclaveStrings.text("Preparing…")
        case .uploading:
            if attachment.progress < 0 { return ConclaveStrings.text("Uploading…") }
            return ConclaveStrings.format("Uploading %lld%%", Int(attachment.progress * 100))
        case .ready: return ConclaveStrings.text("Ready to send")
        case .failed: return failureReason(attachment.failure)
        case .none: return ""
        }
    }

    static var photoLoadFailed: String { ConclaveStrings.text("Couldn't load photo. Tap to retry.") }
    static var photoTitle: String { ConclaveStrings.text("Photo") }
    static var sharePhoto: String { ConclaveStrings.text("Share Photo") }
    static var viewerFailed: String { ConclaveStrings.text("Couldn't load photo.") }
    static var openPhoto: String { ConclaveStrings.text("Open Photo") }
    static var retryPhoto: String { ConclaveStrings.text("Retry Loading Photo") }

    static func photoLabel(_ row: ChatRowModel) -> String {
        let label = ConclaveStrings.format("Photo from %@", ChatCopy.senderName(row))
        if row.photoCaptionIsEmpty || row.plainText.isEmpty { return label }
        return label + ", " + row.plainText
    }

    static func viewerSubtitle(_ row: ChatRowModel) -> String {
        ConclaveStrings.format("Chat Photo Subtitle %@ %@", ChatCopy.senderName(row), ChatCopy.time(row.timestampMillis))
    }

    static func gifLabel(title: String, kind: ChatGifKind) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        switch kind {
        case .gif: return ConclaveStrings.text("GIF")
        case .sticker: return ConclaveStrings.text("Sticker")
        case .clip: return ConclaveStrings.text("Clip")
        }
    }

    static var clipTag: String { ConclaveStrings.text("Clip") }
}

enum ChatMediaSymbols {
    static let addAttachment = ConclaveSymbols.plus
    static let photo = ConclaveSymbols.photo
    static let gif = ConclaveSymbols.faceSmiling
    static let play = ConclaveSymbols.playFill
    static let link = ConclaveSymbols.link
    static let share = ConclaveSymbols.squareAndArrowUp
    static let failed = ConclaveSymbols.exclamationmarkCircleFill
}

private struct ChatPhotoNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {

    var chatPhotoNamespace: Namespace.ID? {
        get { self[ChatPhotoNamespaceKey.self] }
        set { self[ChatPhotoNamespaceKey.self] = newValue }
    }
}

enum ChatImageLoader {

    static let decodeScale: CGFloat = 3

    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 96
        return cache
    }()

    static func cached(_ url: String, maxPixel: Int) -> UIImage? {
        cache.object(forKey: key(url, maxPixel))
    }

    static func load(_ url: String, maxPixel: Int) async -> UIImage? {
        if let hit = cached(url, maxPixel: maxPixel) { return hit }
        guard let data = await loadData(url) else { return nil }
        let decoded = await Task.detached(priority: .userInitiated) {
            ChatImageLoader.decode(data, maxPixel: maxPixel)
        }.value
        if let image = decoded {
            cache.setObject(image, forKey: key(url, maxPixel))
        }
        return decoded
    }

    static func loadData(_ url: String) async -> Data? {
        guard let parsed = URL(string: url) else { return nil }
        if parsed.isFileURL {
            return await Task.detached(priority: .userInitiated) {
                try? Data(contentsOf: parsed)
            }.value
        }
        let scheme = parsed.scheme?.lowercased() ?? ""
        guard scheme == "https" || scheme == "http" else { return nil }
        guard let result = try? await URLSession.shared.data(from: parsed) else { return nil }
        let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 200
        return (200..<300).contains(status) ? result.0 : nil
    }

    static func decode(_ data: Data, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixel),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    static func pixels(_ width: CGFloat, _ height: CGFloat) -> Int {
        Int((max(width, height) * decodeScale).rounded(.up))
    }

    private static func key(_ url: String, _ maxPixel: Int) -> NSString {
        (url + "#" + String(maxPixel)) as NSString
    }
}

struct ChatImageBox: View {
    let url: String
    let width: CGFloat
    let height: CGFloat
    let fill: Bool
    let cornerRadius: CGFloat
    let placeholder: Color
    let failureText: String
    let retriesOnTap: Bool
    let onOpen: (() -> Void)?
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(url: String, width: CGFloat, height: CGFloat, fill: Bool = true,
         cornerRadius: CGFloat = CGFloat(DesignTokens.radiusSmall), placeholder: Color = Color(uiColor: .secondarySystemFill),
         failureText: String = "", retriesOnTap: Bool = false, onOpen: (() -> Void)? = nil) {
        self.url = url
        self.width = width
        self.height = height
        self.fill = fill
        self.cornerRadius = cornerRadius
        self.placeholder = placeholder
        self.failureText = failureText
        self.retriesOnTap = retriesOnTap
        self.onOpen = onOpen
        _image = State(initialValue: ChatImageLoader.cached(url, maxPixel: ChatImageLoader.pixels(width, height)))
    }

    var body: some View {
        let tapEnabled = (failed && retriesOnTap) || (image != nil && onOpen != nil)
        ZStack {
            placeholder
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: fill ? .fill : .fit)
                    .frame(width: width, height: height)
                    .clipped()
                    .transition(reduceMotion ? .identity : .opacity)
            } else if failed {
                VStack(spacing: CGFloat(DesignTokens.space4)) {
                    Image(systemName: ChatMediaSymbols.photo)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    if !failureText.isEmpty {
                        Text(failureText)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                            .minimumScaleFactor(0.8)
                    }
                }
                .padding(CGFloat(DesignTokens.space8))
            } else {
                ProgressView()
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .contentShape(Rectangle())

        .gesture(TapGesture().onEnded { handleTap() }, including: tapEnabled ? .gesture : .subviews)
        .accessibilityAddTraits(tapEnabled ? .isButton : [])
        .accessibilityActions {
            if failed && retriesOnTap {
                Button(ChatMediaCopy.retryPhoto) { retry() }
            }
        }
        .accessibilityIgnoresInvertColors(true)
        .task(id: ChatImageRequestKey(url: url, attempt: attempt)) {
            await load()
        }
    }

    private func handleTap() {
        if failed {
            if retriesOnTap { retry() }
        } else if image != nil {
            onOpen?()
        }
    }

    private func retry() {
        failed = false
        attempt += 1
    }

    private func load() async {
        if image != nil { return }
        if url.isEmpty {
            if !failed { failed = true }
            return
        }
        let loaded = await ChatImageLoader.load(url, maxPixel: ChatImageLoader.pixels(width, height))
        if Task.isCancelled { return }
        if let loaded {
            if reduceMotion {
                image = loaded
            } else {
                withAnimation(.easeOut(duration: 0.15)) { image = loaded }
            }
        } else if !failed {
            failed = true
        }
    }
}

private struct ChatImageRequestKey: Equatable {
    let url: String
    let attempt: Int
}

struct ChatAnimatedImage: View {
    let url: String
    let width: CGFloat
    let height: CGFloat
    var cornerRadius: CGFloat = CGFloat(DesignTokens.radiusSmall)
    var placeholder: Color = Color(uiColor: .secondarySystemFill)
    @State private var data: Data?
    @State private var failed = false
    @State private var isVisible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityPlayAnimatedImages) private var playAnimatedImages

    var body: some View {
        Group {
            if reduceMotion || !playAnimatedImages {
                ChatImageBox(url: url, width: width, height: height, fill: true, cornerRadius: cornerRadius, placeholder: placeholder)
            } else {
                ZStack {
                    placeholder
                    if let data {
                        ChatAnimatedImageRepresentable(data: data, isAnimating: isVisible)
                            .frame(width: width, height: height)
                            .clipped()
                    } else if failed {
                        Image(systemName: ChatMediaSymbols.photo)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .frame(width: width, height: height)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))

                .onAppear { if !isVisible { isVisible = true } }
                .onDisappear { if isVisible { isVisible = false } }
                .task(id: url) {
                    if data != nil { return }
                    let loaded = await ChatImageLoader.loadData(url)
                    if Task.isCancelled { return }
                    if let loaded { data = loaded } else if !failed { failed = true }
                }
            }
        }
        .accessibilityIgnoresInvertColors(true)
    }
}

private struct ChatAnimatedImageRepresentable: UIViewRepresentable {
    let data: Data
    let isAnimating: Bool

    func makeUIView(context: Context) -> ChatAnimatedImageView {
        let view = ChatAnimatedImageView()
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return view
    }

    func updateUIView(_ uiView: ChatAnimatedImageView, context: Context) {
        uiView.update(data: data, animating: isAnimating)
    }

    static func dismantleUIView(_ uiView: ChatAnimatedImageView, coordinator: ()) {
        uiView.stop()
    }
}

final class ChatAnimatedImageView: UIImageView {
    private var currentData: Data?
    private var isRunning = false
    private var generation = 0

    func update(data: Data, animating: Bool) {
        if currentData != data {
            stop()
            currentData = data
        }
        if animating && !isRunning {
            start()
        } else if !animating && isRunning {
            stop()
        }
    }

    func stop() {
        generation += 1
        isRunning = false
    }

    private func start() {
        guard let data = currentData else { return }
        generation += 1
        let mine = generation
        isRunning = true
        let status = CGAnimateImageDataWithBlock(data as CFData, nil) { [weak self] _, frame, stop in
            guard let self = self, self.generation == mine else {
                stop.pointee = true
                return
            }
            self.image = UIImage(cgImage: frame)
        }
        if status != noErr {
            isRunning = false
        }
    }
}

@MainActor
@Observable
final class ChatPhotoViewerModel {
    var image: UIImage? = nil
    var shareURL: URL? = nil
    var failed = false
    var attempt = 0
    var isImmersive = false
}

enum ChatPhotoViewerPlatform {

    static var showsInlineSubtitle: Bool {
        if #available(iOS 26.0, *) { return false }
        return true
    }
}

struct ChatPhotoViewerPage: View {
    let entry: ChatRowEntry
    @State private var model = ChatPhotoViewerModel()
    @Environment(\.chatPhotoNamespace) private var namespace

    var body: some View {
        let row = entry.row
        ChatPhotoViewerContent(row: row, model: model, showsHeader: false, onClose: {})
            .navigationTitle(ChatMediaCopy.photoTitle)
            .navigationBarTitleDisplayMode(.inline)
            .modifier(ChatPhotoViewerSubtitle(text: ChatMediaCopy.viewerSubtitle(row)))
            .toolbar(model.isImmersive ? .hidden : .visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ChatPhotoShareControl(model: model)
                }
            }
            .modifier(ChatPhotoZoomDestination(rowId: row.id, namespace: namespace))
    }
}

struct ChatPhotoViewerSheet: View {
    let entry: ChatRowEntry
    let onClose: () -> Void
    @State private var model = ChatPhotoViewerModel()

    var body: some View {
        ChatPhotoViewerContent(row: entry.row, model: model, showsHeader: true, onClose: onClose)
            .modifier(ChatPhotoPageSizing())
    }
}

private struct ChatPhotoPageSizing: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.presentationSizing(.page)
        } else {
            content
        }
    }
}

private struct ChatPhotoZoomDestination: ViewModifier {
    let rowId: String
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), let namespace {
            content.navigationTransition(.zoom(sourceID: rowId, in: namespace))
        } else {
            content
        }
    }
}

private struct ChatPhotoViewerSubtitle: ViewModifier {
    let text: String

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.navigationSubtitle(Text(text))
        } else {
            content
        }
    }
}

private struct ChatPhotoShareControl: View {
    let model: ChatPhotoViewerModel

    var body: some View {
        if let shareURL = model.shareURL, let image = model.image {
            ShareLink(item: shareURL, preview: SharePreview(ChatMediaCopy.photoTitle, image: Image(uiImage: image))) {
                Image(systemName: ChatMediaSymbols.share)
            }
            .accessibilityLabel(ChatMediaCopy.sharePhoto)
            .accessibilityIdentifier("chat.photoViewer.share")
        } else {
            Button {} label: {
                Image(systemName: ChatMediaSymbols.share)
            }
            .disabled(true)
            .accessibilityLabel(ChatMediaCopy.sharePhoto)
            .accessibilityIdentifier("chat.photoViewer.share")
        }
    }
}

private struct ChatPhotoViewerContent: View {
    let row: ChatRowModel
    let model: ChatPhotoViewerModel
    let showsHeader: Bool
    let onClose: () -> Void
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let immersive = model.isImmersive
        GeometryReader { geometry in
            ZStack {
                (immersive ? HostingTheme.token(DesignTokens.neutralBlack) : Color(uiColor: .systemBackground))
                    .ignoresSafeArea()
                if let image = model.image {
                    ChatZoomableImage(image: image, label: ChatMediaCopy.photoLabel(row), reduceMotion: reduceMotion) {
                        model.isImmersive.toggle()
                    }
                } else if model.failed {
                    VStack(spacing: CGFloat(DesignTokens.space12)) {
                        Text(ChatMediaCopy.viewerFailed)
                            .font(.body)
                            .foregroundStyle(.primary)
                        Button(ConclaveStrings.text("Try Again")) {
                            model.failed = false
                            model.attempt += 1
                        }
                        .buttonStyle(.bordered)
                        .tint(.primary)
                    }
                } else {
                    ProgressView()
                }
            }
            .task(id: model.attempt) {
                let longest = max(geometry.size.width, geometry.size.height)
                await load(maxPixel: Int((longest * max(1, displayScale)).rounded(.up)))
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if showsHeader && !immersive {
                header
            } else if !immersive && ChatPhotoViewerPlatform.showsInlineSubtitle {
                Text(ChatMediaCopy.viewerSubtitle(row))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, CGFloat(DesignTokens.space4))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !immersive && !row.photoCaptionIsEmpty && !row.plainText.isEmpty {
                ScrollView {
                    Text(row.plainText)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, CGFloat(DesignTokens.space16))
                        .padding(.vertical, CGFloat(DesignTokens.space8))
                }
                .frame(maxHeight: 160)
                .fixedSize(horizontal: false, vertical: true)
                .background(Color(uiColor: .systemBackground))
            }
        }
        .accessibilityIdentifier("chat.photoViewer")
    }

    private var header: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            Button(ConclaveStrings.text("Close"), action: onClose)
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
                .accessibilityIdentifier("chat.photoViewer.close")
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                Text(ChatMediaCopy.photoTitle)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Text(ChatMediaCopy.viewerSubtitle(row))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            ChatPhotoShareControl(model: model)
                .frame(minWidth: 44, minHeight: 44)
        }
        .padding(.horizontal, CGFloat(DesignTokens.space16))
        .padding(.vertical, CGFloat(DesignTokens.space8))
        .background(Color(uiColor: .systemBackground))
    }

    private func load(maxPixel: Int) async {
        if model.image == nil, let thumbnail = ChatImageLoader.cached(row.photoURL, maxPixel: ChatImageLoader.pixels(240, 180)) {
            model.image = thumbnail
        }
        guard let data = await ChatImageLoader.loadData(row.photoURL) else {
            if Task.isCancelled { return }
            if model.image == nil { model.failed = true }
            return
        }
        let decoded = await Task.detached(priority: .userInitiated) {
            ChatImageLoader.decode(data, maxPixel: maxPixel)
        }.value
        if Task.isCancelled { return }
        if let decoded {
            model.image = decoded
        } else if model.image == nil {
            model.failed = true
        }
        model.shareURL = await Task.detached(priority: .utility) {
            ChatPhotoShareFile.write(data)
        }.value
    }
}

enum ChatPhotoShareFile {
    static func write(_ data: Data) -> URL? {
        var header: [UInt8] = []
        var index = 0
        while index < ChatPhotoPolicy.sniffLength && index < data.count {
            header.append(data[index])
            index += 1
        }
        let type = ChatPhotoPolicy.sniff(header)
        let name = ChatImageSendPolicy.uploadFileName(originalName: "photo", mimeType: type.isEmpty ? "image/jpeg" : type)
        let folder = URL(fileURLWithPath: ChatPhotoPreparer.outputDirectory()).appendingPathComponent("share", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}

private struct ChatZoomableImage: UIViewRepresentable {
    let image: UIImage
    let label: String
    let reduceMotion: Bool
    let onSingleTap: () -> Void

    func makeUIView(context: Context) -> ChatZoomScrollView {
        ChatZoomScrollView(frame: .zero)
    }

    func updateUIView(_ uiView: ChatZoomScrollView, context: Context) {
        if uiView.imageView.image !== image { uiView.imageView.image = image }
        uiView.imageView.accessibilityLabel = label
        uiView.animatesZoom = !reduceMotion
        uiView.onSingleTap = onSingleTap
    }
}

final class ChatZoomScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    var onSingleTap: () -> Void = {}
    var animatesZoom = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 4
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        backgroundColor = .clear
        contentInsetAdjustmentBehavior = .never
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        imageView.accessibilityIgnoresInvertColors = true
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
        singleTap.require(toFail: doubleTap)
        addGestureRecognizer(singleTap)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale <= minimumZoomScale {
            imageView.frame = bounds
            contentSize = bounds.size
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        imageView
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: animatesZoom)
            return
        }
        let point = recognizer.location(in: imageView)
        let width = bounds.width / 2.5
        let height = bounds.height / 2.5
        zoom(to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), animated: animatesZoom)
    }

    @objc private func handleSingleTap() {
        onSingleTap()
    }
}
#endif
