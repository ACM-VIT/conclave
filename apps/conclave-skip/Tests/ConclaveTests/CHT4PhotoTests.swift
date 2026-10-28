#if !SKIP
import Foundation
import Testing
#if canImport(ImageIO)
import ImageIO
#endif
@testable import Conclave

@MainActor
struct CHT4PhotoTests {
    private func header(_ bytes: [UInt8]) -> [UInt8] {
        var padded = bytes
        while padded.count < 12 { padded.append(0) }
        return padded
    }

    private func ascii(_ text: String) -> [UInt8] {
        Array(text.utf8)
    }

    @Test func sniffingRecognizesTheFiveServerTypesAndHeic() {
        #expect(ChatPhotoPolicy.sniff(header([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) == "image/png")
        #expect(ChatPhotoPolicy.sniff(header([0xFF, 0xD8, 0xFF, 0xE0])) == "image/jpeg")
        #expect(ChatPhotoPolicy.sniff(header(ascii("GIF89a"))) == "image/gif")
        #expect(ChatPhotoPolicy.sniff(ascii("RIFF") + [0, 0, 0, 0] + ascii("WEBP")) == "image/webp")
        #expect(ChatPhotoPolicy.sniff([0, 0, 0, 0x1C] + ascii("ftypavif")) == "image/avif")
        #expect(ChatPhotoPolicy.sniff([0, 0, 0, 0x18] + ascii("ftypheic")) == "image/heic")
        #expect(ChatPhotoPolicy.sniff([0, 0, 0, 0x18] + ascii("ftypmif1")) == "image/heic")
        #expect(ChatPhotoPolicy.sniff([0, 0, 0, 0x18] + ascii("ftypHEIC")) == "image/heic")
        #expect(ChatPhotoPolicy.sniff([0, 0, 0, 0x18] + ascii("ftypisom")) == "")
        #expect(ChatPhotoPolicy.sniff(ascii("%PDF-1.7 abc")) == "")
        #expect(ChatPhotoPolicy.sniff([0xFF, 0xD8]) == "", "fewer than 12 bytes never match")
    }

    @Test func thePlanTranscodesHeicAndLargeStillsAndRefusesLargeGifs() {
        let six = ChatPhotoPolicy.maxBytes
        #expect(six == 6 * 1024 * 1024)
        #expect(ChatPhotoPolicy.plan(mimeType: "image/jpeg", byteCount: six) == ChatPhotoPlan(kind: .upload, failure: .none))
        #expect(ChatPhotoPolicy.plan(mimeType: "image/jpeg", byteCount: six + 1) == ChatPhotoPlan(kind: .transcode, failure: .none))
        #expect(ChatPhotoPolicy.plan(mimeType: "image/png", byteCount: 7_000_000).kind == .transcode)
        #expect(ChatPhotoPolicy.plan(mimeType: "image/heic", byteCount: 900_000).kind == .transcode)
        #expect(ChatPhotoPolicy.plan(mimeType: "image/gif", byteCount: six + 1) == ChatPhotoPlan(kind: .reject, failure: .photoTooLarge))
        #expect(ChatPhotoPolicy.plan(mimeType: "image/gif", byteCount: six).kind == .upload)
        #expect(ChatPhotoPolicy.plan(mimeType: "", byteCount: 10).failure == .photoType)
        #expect(ChatPhotoPolicy.plan(mimeType: "image/jpeg", byteCount: 0).failure == .photoUnavailable)
        #expect(ChatPhotoPolicy.plan(mimeType: "image/jpeg", byteCount: ChatPhotoPolicy.maxInputBytes + 1).failure == .photoTooLarge)
        #expect(ChatPhotoPolicy.path(fromFileURL: "file:///tmp/a%20b.jpg") == "/tmp/a b.jpg")
        #expect(ChatPhotoPolicy.path(fromFileURL: "/tmp/plain.jpg") == "/tmp/plain.jpg")
    }

    @Test func failuresMapFromTheServerAnswers() {
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "anything", code: "chat_image_moderation_blocked") == .photoBlocked)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "That image was blocked by moderation.", code: "") == .photoBlocked,
                "the core's own copy for the moderation code (uploadChatImage)")
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Too many image uploads; please wait a moment.", code: "") == .photoRateLimited)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Image attachments are disabled by the host.", code: "") == .photosDisabled)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Image attachments were disabled by the host.", code: "") == .photosDisabled)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Choose a JPEG, PNG, GIF, WebP, or AVIF image.", code: "") == .photoType)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Chat is locked by the host.", code: "") == .locked)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Watch-only attendees cannot upload images.", code: "") == .attendee)
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: "Image upload authorization expired.", code: "") == .photoUnavailable)
        #expect(ChatPhotoFailurePolicy.isRetryable(.photoUnavailable) && !ChatPhotoFailurePolicy.isRetryable(.photoBlocked))
    }

    @Test func prepareKeepsAFittingJpegRefusesUnknownBytesAndLargeGifs() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cht4-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let jpeg = folder.appendingPathComponent("small.jpg")
        try Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1]).write(to: jpeg)
        let kept = ChatPhotoPreparer.prepareNow(fileURL: jpeg.absoluteString, mimeType: "image/jpeg", fileName: "IMG_0001.jpg",
                                                outputDirectory: folder.path)
        #expect(kept.isReady && !kept.wasTranscoded && kept.mimeType == "image/jpeg" && kept.fileName == "IMG_0001.jpg")
        #expect(kept.fileURL == jpeg.absoluteString)
        let unknown = folder.appendingPathComponent("notes.jpg")
        try Data(ascii("plain text, not an image")).write(to: unknown)
        #expect(ChatPhotoPreparer.prepareNow(fileURL: unknown.absoluteString, mimeType: "image/jpeg", fileName: "notes.jpg",
                                             outputDirectory: folder.path).failure == .photoType)
        let gif = folder.appendingPathComponent("big.gif")
        var gifBytes = Data(ascii("GIF89a"))
        gifBytes.append(Data(count: ChatPhotoPolicy.maxBytes + 10))
        try gifBytes.write(to: gif)
        #expect(ChatPhotoPreparer.prepareNow(fileURL: gif.absoluteString, mimeType: "image/gif", fileName: "big.gif",
                                             outputDirectory: folder.path).failure == .photoTooLarge)
        #expect(ChatPhotoPreparer.prepareNow(fileURL: folder.appendingPathComponent("missing.jpg").absoluteString, mimeType: "",
                                             fileName: "", outputDirectory: folder.path).failure == .photoUnavailable)
    }

    #if canImport(ImageIO)

    private func noiseImage(type: String, to url: URL) -> Bool {
        let width = 4032
        let height = 3024
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        var seed: UInt32 = 2463534242
        var index = 0
        while index < pixels.count {
            seed ^= seed << 13
            seed ^= seed >> 17
            seed ^= seed << 5
            pixels[index] = UInt8(truncatingIfNeeded: seed)
            pixels[index + 1] = UInt8(truncatingIfNeeded: seed >> 8)
            pixels[index + 2] = UInt8(truncatingIfNeeded: seed >> 16)
            pixels[index + 3] = 255
            index += 4
        }
        let space = CGColorSpaceCreateDeviceRGB()
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                  space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let destination = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 1.0] as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }

    @Test func aLargeHeicBecomesAJpegUnderSixMegabytes() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cht4-heic-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let heic = folder.appendingPathComponent("IMG_0002.heic")

        guard noiseImage(type: "public.heic", to: heic) else { return }
        let prepared = ChatPhotoPreparer.prepareNow(fileURL: heic.absoluteString, mimeType: "image/heic", fileName: "IMG_0002.HEIC",
                                                    outputDirectory: folder.path)
        #expect(prepared.isReady && prepared.wasTranscoded)
        #expect(prepared.mimeType == "image/jpeg" && prepared.fileName == "IMG_0002.jpg")
        #expect(prepared.byteCount > 0 && prepared.byteCount <= ChatPhotoPolicy.maxBytes)
        let output = try Data(contentsOf: try #require(URL(string: prepared.fileURL)))
        var head: [UInt8] = []
        for byte in output.prefix(12) { head.append(byte) }
        #expect(ChatPhotoPolicy.sniff(head) == "image/jpeg")
    }

    @Test func aStillPhotoAboveSixMegabytesIsDownscaledToAJpeg() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cht4-png-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let png = folder.appendingPathComponent("scan.png")
        #expect(noiseImage(type: "public.png", to: png))
        let size = ChatPhotoPreparer.fileSize(png.path)
        #expect(size > ChatPhotoPolicy.maxBytes, "the noise PNG must exceed the cap")
        let prepared = ChatPhotoPreparer.prepareNow(fileURL: png.absoluteString, mimeType: "image/png", fileName: "scan.png",
                                                    outputDirectory: folder.path)
        #expect(prepared.isReady && prepared.wasTranscoded && prepared.mimeType == "image/jpeg")
        #expect(prepared.byteCount <= ChatPhotoPolicy.maxBytes)
    }
    #endif

    private func ready(_ url: String) -> ChatAttachmentState {
        ChatAttachmentState(phase: .ready, progress: 1, thumbnailKey: url, failure: .none)
    }

    private func inputs(attachment: ChatAttachmentState, photosEnabled: Bool = true) -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: ChatPoliciesTests.local, localName: "Jordan Lee",
                        messages: [], photosEnabled: photosEnabled, gate: .allowed, roster: ChatPoliciesTests.roster(),
                        assistant: .available, attachment: attachment)
    }

    @Test func attachingShowsPreparingAtOnceThenTheCoreDrivesTheChip() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(inputs(attachment: .none))
        chat.onCommand = { log.append($0) }
        #expect(chat.composer.attachKinds == ["photo", "gif", "voice"])
        chat.attachPhoto(fileURL: "file:///cache/chat-photos/a.jpg", mimeType: "image/jpeg", fileName: "a.jpg")
        #expect(chat.composer.attachment.phase == .preparing && chat.composer.attachment.thumbnailKey == "file:///cache/chat-photos/a.jpg")
        #expect(log.last?.kind == .attachPhoto && log.last?.fileURL == "file:///cache/chat-photos/a.jpg")
        #expect(log.last?.text == "a.jpg" && log.last?.emoji == "image/jpeg")
        #expect(chat.send(text: "caption") == .blocked, "a preparing photo blocks Send")
        #expect(!ChatComposerPolicy.canSend(text: "caption", gate: .allowed, isVoiceMode: false, attachment: chat.composer.attachment))
        let uploading = ChatAttachmentState(phase: .uploading, progress: 0.42, thumbnailKey: "file:///cache/chat-photos/a.jpg", failure: .none)
        chat.apply(inputs(attachment: uploading), change: .attachment)
        #expect(chat.composer.attachment == uploading)
        chat.apply(inputs(attachment: ready("file:///cache/chat-photos/a.jpg")), change: .attachment)
        #expect(ChatComposerPolicy.canSend(text: "", gate: .allowed, isVoiceMode: false, attachment: chat.composer.attachment))
        #expect(chat.send(text: "") == .dispatched, "a ready photo sends alone")
        #expect(log.last?.kind == .send && log.last?.fileURL == "file:///cache/chat-photos/a.jpg" && log.last?.text == "")
        #expect(chat.composer.attachment.phase == .none, "the chip leaves with the send")

        let failed = ChatAttachmentState(phase: .failed, progress: 0, thumbnailKey: "file:///cache/chat-photos/b.jpg", failure: .photoUnavailable)
        chat.apply(inputs(attachment: failed), change: .attachment)
        chat.retryAttachment()
        #expect(log.last?.kind == .retryAttachment && chat.composer.attachment.phase == .preparing)
        chat.removeAttachment()
        #expect(log.last?.kind == .removeAttachment && log.last?.fileURL == "file:///cache/chat-photos/b.jpg")
        #expect(chat.composer.attachment.phase == .none)
        chat.rejectPhoto(.photoTooLarge)
        #expect(chat.composer.inlineNotice == .photoTooLarge)
    }

    @Test func photosFollowPrivateModeAndTheHostSwitch() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(inputs(attachment: .none))
        chat.onCommand = { log.append($0) }
        chat.setPrivateTo(userId: ChatPoliciesTests.avery)
        chat.attachPhoto(fileURL: "file:///x.jpg", mimeType: "image/jpeg", fileName: "x.jpg")
        #expect(log.isEmpty && chat.composer.inlineNotice == .privateTextOnly)
        let off = ChatPoliciesTests.presenter(inputs(attachment: .none, photosEnabled: false))
        off.onCommand = { log.append($0) }
        off.attachPhoto(fileURL: "file:///x.jpg", mimeType: "image/jpeg", fileName: "x.jpg")
        #expect(log.isEmpty && off.composer.inlineNotice == .photosDisabled)
        #expect(ChatComposerPolicy.attachItemReason(kind: "photo", isPrivateMode: true, photosEnabled: true, voiceEnabled: true) == "privateTextOnly")
        #expect(ChatComposerPolicy.attachItemReason(kind: "gif", isPrivateMode: true, photosEnabled: true, voiceEnabled: true) == "privateTextOnly")
        #expect(ChatComposerPolicy.attachItemReason(kind: "photo", isPrivateMode: false, photosEnabled: false, voiceEnabled: true) == "photosDisabled")
        #expect(ChatComposerPolicy.attachItemReason(kind: "gif", isPrivateMode: false, photosEnabled: false, voiceEnabled: true) == "",
                "GIFs stay allowed when photos are off (INM C5)")
    }

    @Test func aReadyPhotoTravelsWithPublicTextOnly() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(inputs(attachment: ready("file:///p.jpg")))
        chat.onCommand = { log.append($0) }
        #expect(chat.send(text: "@Conclave what is this?") == .blocked && chat.composer.inlineNotice == .oneAttachment)
        #expect(chat.send(text: "/help") == .dispatched && log.last?.fileURL == "", "a local command runs and keeps the photo")
        #expect(chat.composer.attachment.isReady)
        #expect(chat.send(text: "@avery look") == .dispatched && log.last?.fileURL == "file:///p.jpg",
                "an implicit private message may carry the photo (the SFU allows an image in a DM)")
        #expect(ChatComposerPolicy.photoRouteFailure(.privateText) == .privateTextOnly)
        #expect(ChatComposerPolicy.photoRouteFailure(.voice) == .oneAttachment)
        #expect(ChatComposerPolicy.photoRouteFailure(.publicText) == .none)
    }

    @Test func mediaKeepsFixedGeometry() {
        #expect(ChatMediaGeometry.photoWidth == 240 && ChatMediaGeometry.photoHeight == 180)
        #expect(ChatMediaGeometry.gifHeight(aspect: 1.8) == 122 && ChatMediaGeometry.gifHeight(aspect: 0.6) == 300)
        #expect(ChatMediaGeometry.gifHeight(aspect: 0) == 220)
        #expect(ChatMediaGeometry.stickerWidth(aspect: 2) == 160 && ChatMediaGeometry.stickerHeight(aspect: 2) == 80)
        #expect(ChatMediaGeometry.stickerWidth(aspect: 0.5) == 80 && ChatMediaGeometry.stickerHeight(aspect: 0.5) == 160)
    }

    @Test func theViewerIsAPushOrAPageSheetAndNeverAFullScreenCover() throws {
        let viewer = try chatSource("Sources/Conclave/Features/Meeting/Chat/ImageViewer+iOS.swift")
        #expect(!viewer.contains(".fullScreenCover") && viewer.contains(".navigationTransition(.zoom(sourceID: rowId, in: namespace))"))
        #expect(viewer.contains("presentationSizing(.page)") && viewer.contains("maximumZoomScale = 4"))
        #expect(viewer.contains("CGImageSourceCreateThumbnailAtIndex") && viewer.contains("CGAnimateImageDataWithBlock"))
        #expect(viewer.contains("accessibilityPlayAnimatedImages") && viewer.contains("ShareLink(item: shareURL"))
        let panel = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift")
        #expect(panel.contains("push(.photo(rowId: rowId))") && panel.contains("photoSheetRowId = rowId"))
        #expect(panel.contains("ChatPhotoViewerPage(entry: chat.rows.entry(for: rowId))"))
        let row = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift")
        #expect(row.contains("matchedTransitionSource(id: rowId, in: namespace)"))
        #expect(row.contains("CGFloat(ChatMediaGeometry.photoWidth)") && row.contains("ChatMediaCopy.photoLoadFailed"))
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/ImageViewer.kt")
        #expect(kotlin.contains("DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)"))
        #expect(kotlin.contains("detectTransformGestures") && kotlin.contains("coerceIn(1f, 4f)"))
        #expect(kotlin.contains(".size(maxOf(1, widthPx), maxOf(1, heightPx))") && kotlin.contains("BitmapFactoryDecoder.Factory()"))
        #expect(kotlin.contains("FileProvider.getUriForFile") && kotlin.contains("PipManager.suppressNextAutoEnter(\"photo_share\")"))
        #expect(kotlin.contains("ImageDecoder.decodeBitmap") && kotlin.contains("Bitmap.CompressFormat.JPEG"))
        let androidRow = try chatSource("Sources/Conclave/Skip/ui/chat/ChatRow.kt")
        #expect(androidRow.contains("ChatMediaGeometry.photoWidth.dp") && androidRow.contains("chat_photo_failed"))
    }

    @Test func everyPhotoReachesThePresenterAsAFile() throws {
        let composer = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift")
        #expect(composer.contains("FileRepresentation(importedContentType: UTType.image)"))
        #expect(composer.contains("preferredItemEncoding: .current") && composer.contains("UIPasteboard.general.hasImages"))
        #expect(!composer.contains("loadTransferable(type: Data.self)") && !composer.contains("UIImage("))
        var cursor = composer.startIndex
        while let range = composer.range(of: "chat.attachPhoto(", range: cursor..<composer.endIndex) {
            let line = composer[range.upperBound...].prefix(80)
            #expect(line.hasPrefix("fileURL: file.url.absoluteString"), "attachPhoto gets a file URL")
            cursor = range.upperBound
        }
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/ChatComposer.kt")
        #expect(kotlin.contains("ActivityResultContracts.PickVisualMedia()") && kotlin.contains("ChatPhotoFiles.copyToCache(context, uri)"))
        #expect(kotlin.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.photoPicker)") && !kotlin.contains("readBytes"))
        let files = try chatSource("Sources/Conclave/Skip/ui/chat/ImageViewer.kt")
        #expect(files.contains("withContext(Dispatchers.IO)") && files.contains("OpenableColumns.SIZE"))
        let preparer = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPhotoPreparer.swift")
        #expect(preparer.contains("Task.detached(priority: TaskPriority.userInitiated)"))
        #expect(preparer.contains("#if SKIP\n        return ChatPhotoCodec.transcodeToJpeg("))
    }

    @Test func buildFilesDeclareCoilTheFileProviderAndThePickerBackport() throws {
        let skip = try chatSource("Sources/Conclave/Skip/skip.yml")
        #expect(skip.contains("'implementation(\"io.coil-kt.coil3:coil-compose:3.4.0\")'"))
        #expect(skip.contains("'implementation(\"io.coil-kt.coil3:coil-gif:3.4.0\")'"))
        let manifest = try chatSource("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:name=\"androidx.core.content.FileProvider\""))
        #expect(manifest.contains("android:authorities=\"${applicationId}.fileprovider\"") && manifest.contains("android:exported=\"false\""))
        #expect(manifest.contains("android:resource=\"@xml/conclave_file_paths\""))
        #expect(manifest.contains("photopicker_activity:0:required"))
        let paths = try chatSource("Android/app/src/main/res/xml/conclave_file_paths.xml")
        #expect(paths.contains("<cache-path name=\"chat_photos\" path=\"chat-photos/\" />"))
        #expect(!paths.contains("<files-path") && !paths.contains("<external-path"))
        #expect(ChatPhotoPreparer.directoryName == "chat-photos")
        for text in [skip, manifest, paths] {
            #expect(!chatHasDash(text))
        }
    }

    @Test func theFixtureScriptsTheAttachmentStates() async {
        await ChatFixtureTestGate.acquire()
        defer { ChatFixtureTestGate.release() }
        let shell = MeetingShellPresenter()
        let driver = ChatFixtureDriver.installOnStage(state: .attachmentUploading, shell: shell)
        #expect(shell.chat.composer.attachment.phase == .uploading && shell.chat.composer.attachment.progress == 0.42)
        #expect(ChatFixtureDriver.state(named: "chat-attachment-uploading") == .attachmentUploading)
        driver.run(.attachPhoto)
        #expect(shell.chat.composer.attachment.phase == .preparing)
        #expect(driver.actionsReadout.contains("attachPhoto"))
        let busy = ChatFixtureScript.inputs(for: .busy, nowMillis: ChatPoliciesTests.base)
        #expect(busy.messages.contains { $0.id == "s-9" && $0.imageURL == ChatFixtureAssets.photoURL })
        #expect(busy.messages.contains { $0.id == "s-9b" && $0.imageURL == ChatFixtureAssets.missingPhotoURL })
    }
}
#endif
