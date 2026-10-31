import Foundation
#if !SKIP && canImport(ImageIO)
import ImageIO
#endif

struct ChatPreparedPhoto: Equatable {

    let fileURL: String
    let mimeType: String

    let fileName: String
    let byteCount: Int
    let wasTranscoded: Bool
    let failure: ChatFailure

    static func failed(_ failure: ChatFailure) -> ChatPreparedPhoto {
        ChatPreparedPhoto(fileURL: "", mimeType: "", fileName: "", byteCount: 0, wasTranscoded: false, failure: failure)
    }

    var isReady: Bool { failure == ChatFailure.none && !fileURL.isEmpty }
}

enum ChatPhotoPlanKind: String, CaseIterable {

    case upload

    case transcode
    case reject
}

struct ChatPhotoPlan: Equatable {
    let kind: ChatPhotoPlanKind
    let failure: ChatFailure
}

enum ChatPhotoPolicy {

    static let maxBytes = ChatImageSendPolicy.maxBytes

    static let maxInputBytes = 64 * 1024 * 1024

    static let jpegQuality = 85

    static let transcodeDimensions: [Int] = [4096, 3072, 2048, 1600]

    static let sniffLength = 12

    static func sniff(_ header: [UInt8]) -> String {
        if header.count < sniffLength { return "" }
        if header[0] == UInt8(0x89) && header[1] == UInt8(0x50) && header[2] == UInt8(0x4E) && header[3] == UInt8(0x47) {
            return "image/png"
        }
        if header[0] == UInt8(0xFF) && header[1] == UInt8(0xD8) && header[2] == UInt8(0xFF) {
            return "image/jpeg"
        }
        if header[0] == UInt8(0x47) && header[1] == UInt8(0x49) && header[2] == UInt8(0x46) {
            return "image/gif"
        }
        if header[0] == UInt8(0x52) && header[1] == UInt8(0x49) && header[2] == UInt8(0x46) && header[3] == UInt8(0x46)
            && header[8] == UInt8(0x57) && header[9] == UInt8(0x45) && header[10] == UInt8(0x42) && header[11] == UInt8(0x50) {
            return "image/webp"
        }

        if header[4] == UInt8(0x66) && header[5] == UInt8(0x74) && header[6] == UInt8(0x79) && header[7] == UInt8(0x70) {
            let brand = brandString(header)
            if brand == "avif" || brand == "avis" { return "image/avif" }
            if brand == "heic" || brand == "heix" || brand == "hevc" || brand == "hevx" || brand == "heim" || brand == "heis"
                || brand == "mif1" || brand == "msf1" {
                return "image/heic"
            }
        }
        return ""
    }

    static func plan(mimeType: String, byteCount: Int) -> ChatPhotoPlan {
        if mimeType.isEmpty { return ChatPhotoPlan(kind: ChatPhotoPlanKind.reject, failure: ChatFailure.photoType) }
        if byteCount <= 0 { return ChatPhotoPlan(kind: ChatPhotoPlanKind.reject, failure: ChatFailure.photoUnavailable) }
        if byteCount > maxInputBytes { return ChatPhotoPlan(kind: ChatPhotoPlanKind.reject, failure: ChatFailure.photoTooLarge) }
        if mimeType == "image/heic" { return ChatPhotoPlan(kind: ChatPhotoPlanKind.transcode, failure: ChatFailure.none) }
        if byteCount <= maxBytes { return ChatPhotoPlan(kind: ChatPhotoPlanKind.upload, failure: ChatFailure.none) }

        if mimeType == "image/gif" { return ChatPhotoPlan(kind: ChatPhotoPlanKind.reject, failure: ChatFailure.photoTooLarge) }
        return ChatPhotoPlan(kind: ChatPhotoPlanKind.transcode, failure: ChatFailure.none)
    }

    static func path(fromFileURL fileURL: String) -> String {
        if fileURL.hasPrefix("file:") {
            return URL(string: fileURL)?.path ?? ""
        }
        return fileURL
    }

    private static func brandString(_ header: [UInt8]) -> String {
        let letters = ChatLinkifyPolicy.characters("abcdefghijklmnopqrstuvwxyz")
        let digits = ChatLinkifyPolicy.characters("0123456789")
        var result = ""
        var index = 8
        while index < 12 {
            let value = Int(header[index])
            if value >= 97 && value <= 122 {
                result += letters[value - 97]
            } else if value >= 65 && value <= 90 {
                result += letters[value - 65]
            } else if value >= 48 && value <= 57 {
                result += digits[value - 48]
            } else {
                return ""
            }
            index += 1
        }
        return result
    }
}

enum ChatPhotoFailurePolicy {
    static func failure(serverMessage: String, code: String) -> ChatFailure {
        if code == ChatImageSendPolicy.moderationBlockedCode { return ChatFailure.photoBlocked }
        let text = serverMessage.lowercased()

        if text.contains("safety check flagged") || text.contains("blocked by moderation") { return ChatFailure.photoBlocked }
        if text.contains("too many image uploads") { return ChatFailure.photoRateLimited }
        if text.contains("image attachments are disabled") || text.contains("image attachments were disabled") {
            return ChatFailure.photosDisabled
        }
        if text.contains("choose a jpeg") || text.contains("type isn't supported") { return ChatFailure.photoType }
        if text.contains("up to 6 mb") || text.contains("too large") { return ChatFailure.photoTooLarge }
        if text.contains("chat is locked") { return ChatFailure.locked }
        if text.contains("watch-only") { return ChatFailure.attendee }
        if text.contains("not in a room") || text.contains("reconnect") { return ChatFailure.notConnected }
        return ChatFailure.photoUnavailable
    }

    static func isRetryable(_ failure: ChatFailure) -> Bool {
        failure == ChatFailure.photoUnavailable || failure == ChatFailure.photoRateLimited || failure == ChatFailure.notConnected
            || failure == ChatFailure.timedOut || failure == ChatFailure.unknown
    }
}

enum ChatPhotoPreparer {

    static let directoryName = "chat-photos"

    static func prepare(fileURL: String, mimeType: String, fileName: String) async -> ChatPreparedPhoto {
        let directory = outputDirectory()
        let task = Task.detached(priority: TaskPriority.userInitiated) {
            ChatPhotoPreparer.prepareNow(fileURL: fileURL, mimeType: mimeType, fileName: fileName, outputDirectory: directory)
        }
        return await task.value
    }

    static func outputDirectory() -> String {

        guard let caches = try? FileManager.default.url(for: FileManager.SearchPathDirectory.cachesDirectory,
                                                        in: FileManager.SearchPathDomainMask.userDomainMask,
                                                        appropriateFor: nil, create: true) else { return "" }
        let folder = caches.appendingPathComponent(directoryName, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: nil)
        return folder.path
    }

    static func prepareNow(fileURL: String, mimeType: String, fileName: String, outputDirectory: String) -> ChatPreparedPhoto {
        let inputPath = ChatPhotoPolicy.path(fromFileURL: fileURL)
        if inputPath.isEmpty || !FileManager.default.fileExists(atPath: inputPath) {
            return ChatPreparedPhoto.failed(ChatFailure.photoUnavailable)
        }
        let declared = fileSize(inputPath)
        if declared > ChatPhotoPolicy.maxInputBytes {
            return ChatPreparedPhoto.failed(ChatFailure.photoTooLarge)
        }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: inputPath)) else {
            return ChatPreparedPhoto.failed(ChatFailure.photoUnavailable)
        }
        var header: [UInt8] = []
        var index = 0
        while index < ChatPhotoPolicy.sniffLength && index < data.count {
            header.append(data[index])
            index += 1
        }
        let sniffed = ChatPhotoPolicy.sniff(header)
        let plan = ChatPhotoPolicy.plan(mimeType: sniffed, byteCount: data.count)
        switch plan.kind {
        case .reject:
            return ChatPreparedPhoto.failed(plan.failure)
        case .upload:
            return ChatPreparedPhoto(fileURL: URL(fileURLWithPath: inputPath).absoluteString, mimeType: sniffed,
                                     fileName: ChatImageSendPolicy.uploadFileName(originalName: fileName, mimeType: sniffed),
                                     byteCount: data.count, wasTranscoded: false, failure: ChatFailure.none)
        case .transcode:
            break
        }
        if outputDirectory.isEmpty { return ChatPreparedPhoto.failed(ChatFailure.photoUnavailable) }
        let outputPath = URL(fileURLWithPath: outputDirectory).appendingPathComponent(UUID().uuidString + ".jpg").path
        for dimension in ChatPhotoPolicy.transcodeDimensions {
            let written = transcode(inputPath: inputPath, outputPath: outputPath, maxDimension: dimension,
                                    quality: ChatPhotoPolicy.jpegQuality)
            if written < 0 {
                try? FileManager.default.removeItem(atPath: outputPath)

                return ChatPreparedPhoto.failed(ChatFailure.photoType)
            }
            if written > 0 && written <= ChatPhotoPolicy.maxBytes {
                return ChatPreparedPhoto(fileURL: URL(fileURLWithPath: outputPath).absoluteString, mimeType: "image/jpeg",
                                         fileName: ChatImageSendPolicy.uploadFileName(originalName: fileName, mimeType: "image/jpeg"),
                                         byteCount: written, wasTranscoded: true, failure: ChatFailure.none)
            }
        }
        try? FileManager.default.removeItem(atPath: outputPath)
        return ChatPreparedPhoto.failed(ChatFailure.photoTooLarge)
    }

    static func fileSize(_ path: String) -> Int {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return 0 }
        let value = attributes[FileAttributeKey.size]
        if let size = value as? Int { return size }
        if let size = value as? Int64 { return Int(size) }
        return 0
    }

    static func transcode(inputPath: String, outputPath: String, maxDimension: Int, quality: Int) -> Int {
        #if SKIP
        return ChatPhotoCodec.transcodeToJpeg(inputPath: inputPath, outputPath: outputPath, maxDimension: maxDimension,
                                              quality: quality)
        #elseif canImport(ImageIO)
        let inputURL = URL(fileURLWithPath: inputPath)
        guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil) else { return -1 }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else { return -1 }
        let outputURL = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: outputURL)
        guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.jpeg" as CFString, 1, nil) else {
            return -1
        }
        let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100.0]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return -1 }
        return fileSize(outputPath)
        #else
        return -1
        #endif
    }
}
