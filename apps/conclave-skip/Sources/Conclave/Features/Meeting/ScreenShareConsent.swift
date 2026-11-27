import Foundation

@MainActor
protocol ScreenShareConsentPort: AnyObject {
    var onProjectionRevoked: (() -> Void)? { get set }
    func requestConsent() async -> Int?
    func lastConsentFailure() -> ScreenShareFailure
    func isConsentActive(_ grant: Int) -> Bool
    func releaseConsent(_ grant: Int)
    func stopCapture()
}

@MainActor
final class ScreenShareConsentHold {
    var grant: Int?
}

#if SKIP
@MainActor
final class AndroidScreenShareConsent: ScreenShareConsentPort {
    var onProjectionRevoked: (() -> Void)? {
        get { ScreenCaptureManager.onProjectionRevoked }
        set { ScreenCaptureManager.onProjectionRevoked = newValue }
    }

    func requestConsent() async -> Int? {
        return await ScreenCaptureManager.requestConsent()
    }

    func lastConsentFailure() -> ScreenShareFailure {
        return ScreenCaptureManager.lastStartFailure()
    }

    func isConsentActive(_ grant: Int) -> Bool {
        return ScreenCaptureManager.isConsentActive(grant)
    }

    func releaseConsent(_ grant: Int) {
        ScreenCaptureManager.releaseConsent(grant)
    }

    func stopCapture() {
        ScreenCaptureManager.stopCapture()
    }
}
#endif
