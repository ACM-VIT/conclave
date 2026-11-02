#if !SKIP
import Testing
@testable import Conclave

struct MacCameraPolicyTests {
    private let iphone = [
        CameraCandidate(id: "back-wide", position: .back, kind: .builtInWide),
        CameraCandidate(id: "back-dual", position: .back, kind: .builtIn),
        CameraCandidate(id: "front-truedepth", position: .front, kind: .builtIn),
        CameraCandidate(id: "front-wide", position: .front, kind: .builtInWide),
    ]

    private let mac = [
        CameraCandidate(id: "facetime", position: .unspecified, kind: .builtInWide),
        CameraCandidate(id: "desk", position: .unspecified, kind: .deskView),
    ]

    @Test func phonesKeepTheirWideAngleFrontAndBackCameras() throws {
        #expect(CameraDeviceSelectionPolicy.select(iphone, wanted: .front)?.id == "front-wide")
        #expect(CameraDeviceSelectionPolicy.select(iphone, wanted: .back)?.id == "back-wide")
        #expect(CameraDeviceSelectionPolicy.select(iphone, wanted: .front, systemPreferredId: "back-wide")?.id == "front-wide")
        #expect(CameraDeviceSelectionPolicy.canSwitch(iphone))
    }

    @Test func anIPadWithAnExternalCameraStillOpensTheFrontCamera() {
        let ipad = iphone + [CameraCandidate(id: "usb", position: .unspecified, kind: .attached)]
        #expect(CameraDeviceSelectionPolicy.select(ipad, wanted: .front, systemPreferredId: "usb")?.id == "front-wide")
        #expect(CameraDeviceSelectionPolicy.select(ipad, wanted: .back)?.id == "back-wide")
    }

    @Test func aMacCameraWithNoPositionIsUsedForTheFrontAndCannotFlip() {
        #expect(CameraDeviceSelectionPolicy.select(mac, wanted: .front)?.id == "facetime")
        #expect(CameraDeviceSelectionPolicy.select(mac, wanted: .unspecified)?.id == "facetime")
        #expect(CameraDeviceSelectionPolicy.select(mac, wanted: .back) == nil)
        #expect(!CameraDeviceSelectionPolicy.canSwitch(mac))
        #expect(CameraDeviceSelectionPolicy.select([mac[1]], wanted: .front) == nil)
    }

    @Test func aMacFollowsTheSystemPreferredCameraAndRanksBuiltInFirst() {
        let docked = [
            CameraCandidate(id: "continuity", position: .unspecified, kind: .continuity),
            CameraCandidate(id: "usb", position: .unspecified, kind: .attached),
            CameraCandidate(id: "facetime", position: .unspecified, kind: .builtInWide),
        ]
        #expect(CameraDeviceSelectionPolicy.select(docked, wanted: .front)?.id == "facetime")
        #expect(CameraDeviceSelectionPolicy.select(docked, wanted: .front, systemPreferredId: "continuity")?.id == "continuity")
        #expect(CameraDeviceSelectionPolicy.select(docked, wanted: .front, systemPreferredId: "gone")?.id == "facetime")
        #expect(CameraDeviceSelectionPolicy.select(Array(docked.prefix(2)), wanted: .front)?.id == "usb")
        #expect(CameraDeviceSelectionPolicy.select([], wanted: .front) == nil)
    }

    @Test func aCameraThatReportsOnlyABackPositionStillServesAFrontRequest() {
        let backOnly = [CameraCandidate(id: "rear", position: .back, kind: .builtInWide)]
        #expect(CameraDeviceSelectionPolicy.select(backOnly, wanted: .front)?.id == "rear")
        #expect(!CameraDeviceSelectionPolicy.canSwitch(backOnly))
    }

    @Test func formatSelectionKeepsTheNearestLandscapeFormat() {
        let phone = [
            CameraFormatCandidate(width: 640, height: 480),
            CameraFormatCandidate(width: 1280, height: 720),
            CameraFormatCandidate(width: 1280, height: 720),
            CameraFormatCandidate(width: 1920, height: 1080),
        ]
        #expect(CameraFormatSelectionPolicy.selectIndex(phone, targetWidth: 1280, targetHeight: 720) == 1)
        #expect(CameraFormatSelectionPolicy.selectIndex(phone, targetWidth: 640, targetHeight: 360) == 0)
        #expect(CameraFormatSelectionPolicy.selectIndex([], targetWidth: 1280, targetHeight: 720) == nil)

        let macBook = [
            CameraFormatCandidate(width: 640, height: 480),
            CameraFormatCandidate(width: 1280, height: 720),
            CameraFormatCandidate(width: 1760, height: 1328),
            CameraFormatCandidate(width: 1328, height: 1760),
            CameraFormatCandidate(width: 1552, height: 1552),
            CameraFormatCandidate(width: 1080, height: 1920),
            CameraFormatCandidate(width: 1920, height: 1080),
        ]
        #expect(CameraFormatSelectionPolicy.selectIndex(macBook, targetWidth: 1280, targetHeight: 720) == 1)
        #expect(CameraFormatSelectionPolicy.selectIndex(macBook, targetWidth: 640, targetHeight: 360) == 0)
        #expect(CameraFormatSelectionPolicy.selectIndex(macBook, targetWidth: 1920, targetHeight: 1080) == 6)
        let sideways = [CameraFormatCandidate(width: 800, height: 1000), CameraFormatCandidate(width: 1920, height: 1080)]
        #expect(CameraFormatSelectionPolicy.selectIndex(sideways, targetWidth: 1280, targetHeight: 720) == 1)
        let portraitOnly = [CameraFormatCandidate(width: 720, height: 1280)]
        #expect(CameraFormatSelectionPolicy.selectIndex(portraitOnly, targetWidth: 1280, targetHeight: 720) == 0)
    }

    @Test func frameRateStaysInsideTheCameraRange() throws {
        let phone = [CameraFrameRateRange(minimum: 1, maximum: 30)]
        #expect(CameraFrameRatePolicy.select(target: 30, ranges: phone) == 30)
        #expect(CameraFrameRatePolicy.select(target: 60, ranges: phone) == 30)
        #expect(CameraFrameRatePolicy.select(target: 8, ranges: phone) == 8)

        let macBook = [CameraFrameRateRange(minimum: 15, maximum: 30)]
        #expect(CameraFrameRatePolicy.select(target: 8, ranges: macBook) == 15)
        #expect(CameraFrameRatePolicy.select(target: 12, ranges: macBook) == 15)
        #expect(CameraFrameRatePolicy.select(target: 20, ranges: macBook) == 20)

        let split = [CameraFrameRateRange(minimum: 15, maximum: 15), CameraFrameRateRange(minimum: 30, maximum: 30)]
        #expect(CameraFrameRatePolicy.select(target: 24, ranges: split) == 30)
        #expect(CameraFrameRatePolicy.select(target: 18, ranges: split) == 15)
        #expect(CameraFrameRatePolicy.select(target: 30, ranges: []) == nil)
        #expect(CameraFrameRatePolicy.select(target: 30, ranges: [CameraFrameRateRange(minimum: 0, maximum: 0.5)]) == nil)
    }

    @Test func captureFpsIsAnIntegerTheCameraAccepts() {
        let phone = [CameraFrameRateRange(minimum: 1, maximum: 30)]
        #expect(CameraFrameRatePolicy.captureFps(30, ranges: phone) == 30)
        #expect(CameraFrameRatePolicy.captureFps(8, ranges: phone) == 8)
        let ntsc = [CameraFrameRateRange(minimum: 15.000015, maximum: 29.97)]
        let low = CameraFrameRatePolicy.select(target: 8, ranges: ntsc) ?? 0
        #expect(CameraFrameRatePolicy.captureFps(low, ranges: ntsc) == 16)
        let high = CameraFrameRatePolicy.select(target: 30, ranges: ntsc) ?? 0
        #expect(CameraFrameRatePolicy.captureFps(high, ranges: ntsc) == 29)
    }
}
#endif
