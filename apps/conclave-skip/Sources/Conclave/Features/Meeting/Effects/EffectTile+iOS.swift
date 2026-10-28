#if os(iOS) && !SKIP
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// S60 0.6 L6-7 (SET-6) on iOS: `EffectTile`, a 64 x 64 pt flat thumbnail with its caption, a 2 pt coral ring and a
// 20 pt check badge when selected and a system spinner while the engine applies it (4 c, e, h: no animation on the
// ring or badge). One accessibility element: the effect name, the value "Selected" or "Applying", the button trait plus
// `.isSelected` (4 i). Thumbnails are flat (R12): catalog art ships with the WP10 engine, so a catalog tile shows a flat
// raised surface with a concept glyph, and a personal tile its stored JPEG decoded at tile size.

enum EffectTileMetrics {
    static let thumbnail: CGFloat = 64
    static let cornerRadius: CGFloat = 12
    static let ring: CGFloat = 2
    static let badge: CGFloat = 20
    static let spacing: CGFloat = 6
}

struct EffectTile: View {
    let item: EffectItem
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: EffectTileMetrics.spacing) {
                EffectThumbnail(item: item)
                    .frame(width: EffectTileMetrics.thumbnail, height: EffectTileMetrics.thumbnail)
                    .clipShape(RoundedRectangle(cornerRadius: EffectTileMetrics.cornerRadius, style: .continuous))
                    .overlay {
                        if item.isSelected {
                            RoundedRectangle(cornerRadius: EffectTileMetrics.cornerRadius, style: .continuous)
                                .strokeBorder(HostingTheme.coralFill, lineWidth: EffectTileMetrics.ring)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if item.isSelected {
                            Image(systemName: ConclaveSymbols.checkmark)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HostingTheme.inCallOnCoral)
                                .frame(width: EffectTileMetrics.badge, height: EffectTileMetrics.badge)
                                .background(Circle().fill(HostingTheme.coralFill))
                                .offset(x: 4, y: -4)
                                .accessibilityHidden(true)
                        }
                    }
                    .overlay {
                        if item.isProcessing {
                            ProgressView()
                                .accessibilityHidden(true)
                        }
                    }
                Text(EffectsCopy.itemTitle(item))
                    .font(.caption)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(width: EffectTileMetrics.thumbnail + 8)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || item.isBlockedBySystem)
        .opacity(isEnabled && !item.isBlockedBySystem ? 1 : HostingTheme.disabledOpacity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(EffectsCopy.itemTitle(item))
        .accessibilityValue(EffectsCopy.tileValue(item))
        .accessibilityHint(EffectsCopy.blockedReason(item) ?? "")
        .accessibilityAddTraits(item.isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("effects.tile." + item.id)
    }
}

/// The flat thumbnail: the stored personal image at tile size, else the raised in-call surface with a glyph.
private struct EffectThumbnail: View {
    let item: EffectItem
    @State private var image: UIImage? = nil

    var body: some View {
        ZStack {
            HostingTheme.token(DesignTokens.iosInCallSurfaceRaised)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: item.kind == EffectKind.none ? ConclaveSymbols.xmark : ConclaveSymbols.photo)
                    .font(.title3)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
        .accessibilityHidden(true)
        .task(id: item.assetName) {
            guard item.kind == EffectKind.personal else { return }
            let name = item.assetName
            let loaded = await Task.detached(priority: .utility) {
                EffectsPhotoStore.thumbnail(fileName: name, maxPixels: Int(EffectTileMetrics.thumbnail * 3))
            }.value
            if Task.isCancelled { return }
            image = loaded
        }
    }
}

/// The Add Photo tile's face (the `PhotosPicker` label, 4 c): the same geometry as a tile.
struct EffectAddPhotoFace: View {
    let isEnabled: Bool

    var body: some View {
        VStack(spacing: EffectTileMetrics.spacing) {
            ZStack {
                HostingTheme.token(DesignTokens.iosInCallSurfaceRaised)
                Image(systemName: ConclaveSymbols.photoOnRectangle)
                    .font(.title3)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
            .frame(width: EffectTileMetrics.thumbnail, height: EffectTileMetrics.thumbnail)
            .clipShape(RoundedRectangle(cornerRadius: EffectTileMetrics.cornerRadius, style: .continuous))
            Text(ConclaveStrings.text("Add Photo"))
                .font(.caption)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(width: EffectTileMetrics.thumbnail + 8)
        }
        .opacity(isEnabled ? 1 : HostingTheme.disabledOpacity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ConclaveStrings.text("Add Photo"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("effects.addPhoto")
    }
}

/// Personal images in the app container (S60 4 j): decoded with `CGImageSource` (HEIC and HEIF arrive as JPEG through
/// `preferredItemEncoding: .compatible`; PNG and WebP decode as they are), scaled along the web's output ladder and
/// stored as JPEG under Application Support. Nonisolated and synchronous: callers run it off the main actor.
enum EffectsPhotoStore {
    static let directoryName = "conclave-effects"

    static func directory() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return base.appendingPathComponent(directoryName, isDirectory: true)
    }

    static func url(fileName: String) -> URL? {
        directory()?.appendingPathComponent(fileName, isDirectory: false)
    }

    /// Stores `data` as `fileName`; `.none` on success, else the issue to show.
    static func store(_ data: Data, fileName: String, personalCount: Int) -> EffectsIssue {
        let early = EffectsImagePolicy.sourceIssue(byteCount: data.count, personalCount: personalCount)
        if early != EffectsIssue.none { return early }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            return EffectsIssue.format
        }
        var encoded: [Int] = []
        for attempt in EffectsImagePolicy.attempts {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: attempt.maxDimension,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                return EffectsIssue.decode
            }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
                return EffectsIssue.unavailable
            }
            let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: attempt.quality]
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return EffectsIssue.unavailable }
            encoded.append(output.length)
            if EffectsImagePolicy.fitsEncodedCap(byteCount: output.length) {
                guard let folder = directory(), let target = url(fileName: fileName) else { return EffectsIssue.unavailable }
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try (output as Data).write(to: target, options: .atomic)
                    return EffectsIssue.none
                } catch {
                    return EffectsIssue.unavailable
                }
            }
        }
        return EffectsImagePolicy.encodeIssue(decoded: true, encodedByteCounts: encoded)
    }

    static func remove(fileName: String) {
        guard let target = url(fileName: fileName) else { return }
        try? FileManager.default.removeItem(at: target)
    }

    /// A stored image decoded at tile size (never the full image, 4 k).
    static func thumbnail(fileName: String, maxPixels: Int) -> UIImage? {
        guard let target = url(fileName: fileName), let source = CGImageSourceCreateWithURL(target as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
#endif
