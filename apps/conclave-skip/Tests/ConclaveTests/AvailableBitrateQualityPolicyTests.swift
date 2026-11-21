#if !SKIP
import Testing
@testable import Conclave

struct AvailableBitrateQualityPolicyTests {

    private func receiveQuality(available: Double, received: Double) -> ConnectionQuality {
        AvailableBitrateQualityPolicy.receiveQuality(
            availableBitrate: available,
            mediaBitrate: received,
            fairBitrate: 500_000,
            poorBitrate: 240_000,
            emergencyBitrate: 120_000
        )
    }

    @Test func aReceiverUsingNearlyAllOfItsBandwidthIsJudgedByIt() {
        #expect(receiveQuality(available: 400_000, received: 380_000) == .fair)
        #expect(receiveQuality(available: 200_000, received: 190_000) == .poor)
        #expect(receiveQuality(available: 100_000, received: 95_000) == .emergency)
    }

    @Test func aReceiverWithHeadroomOrPlentyOfBandwidthIsNotWeak() {
        #expect(receiveQuality(available: 200_000, received: 60_000) == .unknown)
        #expect(receiveQuality(available: 900_000, received: 880_000) == .unknown)
    }
}
#endif
