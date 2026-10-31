import Foundation
import Observation

struct ConnectionStatsCounters: Equatable {

    let timestampMillis: Double

    let rttMillis: Double?

    let jitterMillis: Double?

    let packetsLost: Double
    let packetsReceived: Double

    let remoteLossFraction: Double?

    let videoBytesSent: Double?
    let audioBytesSent: Double?

    let bytesSent: Double?
    let bytesReceived: Double?

    let videoCodec: String

    init(timestampMillis: Double, rttMillis: Double?, jitterMillis: Double?, packetsLost: Double, packetsReceived: Double,
         remoteLossFraction: Double?, videoBytesSent: Double?, audioBytesSent: Double?, bytesSent: Double?,
         bytesReceived: Double?, videoCodec: String) {
        self.timestampMillis = timestampMillis
        self.rttMillis = rttMillis
        self.jitterMillis = jitterMillis
        self.packetsLost = packetsLost
        self.packetsReceived = packetsReceived
        self.remoteLossFraction = remoteLossFraction
        self.videoBytesSent = videoBytesSent
        self.audioBytesSent = audioBytesSent
        self.bytesSent = bytesSent
        self.bytesReceived = bytesReceived
        self.videoCodec = videoCodec
    }
}

struct ConnectionStatsValues: Equatable {
    let latencyMillis: Int?
    let packetLossPercent: Double?
    let jitterMillis: Int?
    let videoBitrateKbps: Int?
    let audioBitrateKbps: Int?

    let videoCodec: String
    let uploadKbps: Int?
    let downloadKbps: Int?

    init(latencyMillis: Int?, packetLossPercent: Double?, jitterMillis: Int?, videoBitrateKbps: Int?, audioBitrateKbps: Int?,
         videoCodec: String, uploadKbps: Int?, downloadKbps: Int?) {
        self.latencyMillis = latencyMillis
        self.packetLossPercent = packetLossPercent
        self.jitterMillis = jitterMillis
        self.videoBitrateKbps = videoBitrateKbps
        self.audioBitrateKbps = audioBitrateKbps
        self.videoCodec = videoCodec
        self.uploadKbps = uploadKbps
        self.downloadKbps = downloadKbps
    }

    static let empty = ConnectionStatsValues(latencyMillis: nil, packetLossPercent: nil, jitterMillis: nil,
                                             videoBitrateKbps: nil, audioBitrateKbps: nil, videoCodec: "",
                                             uploadKbps: nil, downloadKbps: nil)
}

enum ConnectionStatsPolicy {

    static let intervalMillis = 1000.0

    static func values(current: ConnectionStatsCounters, previous: ConnectionStatsCounters?) -> ConnectionStatsValues {
        var elapsed = 0.0
        if let previous {
            elapsed = current.timestampMillis - previous.timestampMillis
        }
        let downloadLoss = windowedLossPercent(lost: current.packetsLost, received: current.packetsReceived,
                                               previousLost: previous?.packetsLost, previousReceived: previous?.packetsReceived)
        var loss: Double? = downloadLoss
        if let fraction = current.remoteLossFraction {
            let remote = fraction * 100.0
            if let known = loss {
                loss = known > remote ? known : remote
            } else {
                loss = remote
            }
        }
        return ConnectionStatsValues(
            latencyMillis: rounded(current.rttMillis),
            packetLossPercent: loss,
            jitterMillis: rounded(current.jitterMillis),
            videoBitrateKbps: rateKbps(current: current.videoBytesSent, previous: previous?.videoBytesSent, elapsedMillis: elapsed),
            audioBitrateKbps: rateKbps(current: current.audioBytesSent, previous: previous?.audioBytesSent, elapsedMillis: elapsed),
            videoCodec: current.videoCodec,
            uploadKbps: rateKbps(current: current.bytesSent, previous: previous?.bytesSent, elapsedMillis: elapsed),
            downloadKbps: rateKbps(current: current.bytesReceived, previous: previous?.bytesReceived, elapsedMillis: elapsed)
        )
    }

    static func rateKbps(current: Double?, previous: Double?, elapsedMillis: Double) -> Int? {
        guard let current, let previous, elapsedMillis > 0 else { return nil }
        let delta = current - previous
        if delta < 0 { return nil }
        return Int((delta * 8.0 / elapsedMillis) + 0.5)
    }

    static func windowedLossPercent(lost: Double, received: Double, previousLost: Double?, previousReceived: Double?) -> Double? {
        guard let previousLost, let previousReceived else { return nil }
        let lostDelta = lost - previousLost
        let receivedDelta = received - previousReceived
        if lostDelta < 0 || receivedDelta < 0 { return nil }
        let expected = lostDelta + receivedDelta
        if expected <= 0 { return nil }
        return lostDelta * 100.0 / expected
    }

    static func codecName(mimeType: String) -> String {
        let trimmed = mimeType.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("video/") {
            return String(trimmed.dropFirst(6))
        }
        return trimmed
    }

    private static func rounded(_ value: Double?) -> Int? {
        guard let value else { return nil }
        if value < 0 { return nil }
        return Int(value + 0.5)
    }
}

@MainActor
@Observable
final class ConnectionStatsModel {
    private(set) var values: ConnectionStatsValues = ConnectionStatsValues.empty

    private(set) var isFrozen = false

    @ObservationIgnored var source: (() -> ConnectionStatsCounters?)? = nil

    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(millis * 1_000_000.0))
    }

    @ObservationIgnored private(set) var pollCount = 0
    @ObservationIgnored private(set) var subscriberCount = 0
    @ObservationIgnored private var previous: ConnectionStatsCounters? = nil
    @ObservationIgnored private var runToken = 0

    init() {}

    var isSubscribed: Bool { subscriberCount > 0 }

    func observe() async {
        subscribe()
        while !Task.isCancelled && isSubscribed {
            await sleep(250.0)
        }
        unsubscribe()
    }

    func subscribe() {
        subscriberCount += 1
        if subscriberCount > 1 { return }
        runToken += 1
        let token = runToken
        previous = nil
        let pause = sleep
        Task { @MainActor [weak self] in
            while true {
                guard let strong = self, strong.subscriberCount > 0, strong.runToken == token else { return }
                strong.poll()
                await pause(ConnectionStatsPolicy.intervalMillis)
            }
        }
    }

    func unsubscribe() {
        if subscriberCount == 0 { return }
        subscriberCount -= 1
        if subscriberCount > 0 { return }
        runToken += 1
        previous = nil
    }

    func setFrozen(_ frozen: Bool) {
        guard frozen != isFrozen else { return }
        isFrozen = frozen
        previous = nil
    }

    func reset() {
        previous = nil
        if values != ConnectionStatsValues.empty { values = ConnectionStatsValues.empty }
    }

    private func poll() {
        if isFrozen { return }
        pollCount += 1
        guard let reading = source?() else {
            previous = nil
            return
        }
        let next = ConnectionStatsPolicy.values(current: reading, previous: previous)
        previous = reading
        if next != values { values = next }
    }
}
