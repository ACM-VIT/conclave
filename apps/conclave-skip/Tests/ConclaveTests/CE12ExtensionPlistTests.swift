#if !SKIP
import Foundation
import Testing

struct CE12ExtensionPlistTests {
    static let purposeStrings: Set<String> = [
        "NSCameraUsageDescription",
        "NSMicrophoneUsageDescription",
        "NSLocalNetworkUsageDescription",
    ]

    @Test func theBroadcastExtensionDeclaresOnlyTheKeysItUses() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("Darwin/ScreenShareExtension/Info.plist"))
        let plist = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        let purposes = Set(plist.keys.filter { $0.hasSuffix("UsageDescription") || $0.hasSuffix("UsageDescriptionDictionary") })
        #expect(purposes == Self.purposeStrings, "\(purposes.symmetricDifference(Self.purposeStrings).sorted())")
        for key in purposes.sorted() {
            let value = plist[key] as? String
            #expect(value?.hasPrefix("Conclave ") == true, "\(key)")
            #expect(value?.contains("$(") == false, "\(key)")
        }

        let extensionInfo = try #require(plist["NSExtension"] as? [String: Any])
        #expect(extensionInfo["NSExtensionPointIdentifier"] as? String == "com.apple.broadcast-services-upload")
        #expect(extensionInfo["RPBroadcastProcessMode"] as? String == "RPBroadcastProcessModeSampleBuffer")
        #expect(plist["RTCAppGroupIdentifier"] as? String == "group.com.acmvit.conclave.screenshare")
    }
}
#endif
