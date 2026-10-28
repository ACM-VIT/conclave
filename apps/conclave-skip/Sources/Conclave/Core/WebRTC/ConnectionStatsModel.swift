import Foundation
import Observation

// SET-3 (S60 0.8 C6-9, 2 c `.connection`, 2 f, 2 k, 2 l3): the Settings > Connection details. Each WebRTC client reads
// one raw reading of its transports' stats (`sampleConnectionStatsCounters()`, cumulative counters only, no windows of
// its own, so the 2 s quality sampler's windows are never disturbed); the shared policy turns two readings into the
// values the page shows; the hot leaf `ConnectionStatsModel` polls at 1 Hz only while the Connection page is visible
// (`observe()` for the iOS page task, `subscribe()` and `unsubscribe()` for the Android page effect) and never while
// nobody subscribes (zero `stats.polls`). Transpiled for both platforms (Skip Lite: scalar structs, optionals,
// closures, no self-observation). Values are raw numbers; each platform formats them through its Settings copy file.

/// One raw reading from a client: cumulative counters from the send and receive transports' stats reports. Optional
/// values are absent from the report (no data yet).
struct ConnectionStatsCounters: Equatable {
    /// Wall clock of the reading, milliseconds (Double: Skip maps Swift Int to a 32-bit Kotlin Int).
    let timestampMillis: Double
    /// Nominated candidate pair `currentRoundTripTime`, else `remote-inbound-rtp` `roundTripTime`, milliseconds.
    let rttMillis: Double?
    /// `inbound-rtp` and `remote-inbound-rtp` jitter, the larger of the two, milliseconds.
    let jitterMillis: Double?
    /// Cumulative `inbound-rtp` packets lost and received (download), for the windowed loss.
    let packetsLost: Double
    let packetsReceived: Double
    /// `remote-inbound-rtp` `fractionLost` (0 to 1, already windowed by RTCP): loss on what you send.
    let remoteLossFraction: Double?
    /// Cumulative `outbound-rtp` bytes per kind (your camera and your microphone).
    let videoBytesSent: Double?
    let audioBytesSent: Double?
    /// Cumulative bytes on the send transport's nominated pair (upload) and the receive transport's (download).
    let bytesSent: Double?
    let bytesReceived: Double?
    /// The codec of your sent video (`codec.mimeType` without the "video/" prefix), "" while you send none.
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

/// What the Connection page shows (2 g "Details"): nil reads "No data yet".
struct ConnectionStatsValues: Equatable {
    let latencyMillis: Int?
    let packetLossPercent: Double?
    let jitterMillis: Int?
    let videoBitrateKbps: Int?
    let audioBitrateKbps: Int?
    /// "" reads "No data yet".
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

/// The pure arithmetic (unit tested on both platforms).
enum ConnectionStatsPolicy {
    /// C6-9: 1 Hz while subscribed.
    static let intervalMillis = 1000.0

    /// Two readings to the page values. Rates and the download loss need a previous reading; latency, jitter, the
    /// codec and the remote loss fraction come from the current one.
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

    /// Kilobits per second between two cumulative byte counters; nil without both readings, a positive window or
    /// while a counter went backwards (a transport was replaced).
    static func rateKbps(current: Double?, previous: Double?, elapsedMillis: Double) -> Int? {
        guard let current, let previous, elapsedMillis > 0 else { return nil }
        let delta = current - previous
        if delta < 0 { return nil }
        return Int((delta * 8.0 / elapsedMillis) + 0.5)
    }

    /// Download loss over the window in percent; nil until a previous reading exists or while nothing arrived.
    static func windowedLossPercent(lost: Double, received: Double, previousLost: Double?, previousReceived: Double?) -> Double? {
        guard let previousLost, let previousReceived else { return nil }
        let lostDelta = lost - previousLost
        let receivedDelta = received - previousReceived
        if lostDelta < 0 || receivedDelta < 0 { return nil }
        let expected = lostDelta + receivedDelta
        if expected <= 0 { return nil }
        return lostDelta * 100.0 / expected
    }

    /// "video/VP8" reads "VP8"; anything else reads as given.
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

/// C6-9 hot leaf: the Connection page's details, read only by the details rows. Polls the client at 1 Hz while at
/// least one page subscribes; frozen while the call recovers (2 f: "values freeze"); never polls otherwise.
@MainActor
@Observable
final class ConnectionStatsModel {
    private(set) var values: ConnectionStatsValues = ConnectionStatsValues.empty
    /// True while the call recovers: the page keeps the last values and shows "Reconnecting".
    private(set) var isFrozen = false

    /// The core installs the client's reading (`WebRTCClient.sampleConnectionStatsCounters()`); nil reads no data.
    @ObservationIgnored var source: (() -> ConnectionStatsCounters?)? = nil
    /// Test seam (milliseconds).
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(millis * 1_000_000.0))
    }
    /// Debug readout `stats.polls` (L6-12): one per client reading.
    @ObservationIgnored private(set) var pollCount = 0
    @ObservationIgnored private(set) var subscriberCount = 0
    @ObservationIgnored private var previous: ConnectionStatsCounters? = nil
    @ObservationIgnored private var runToken = 0

    init() {}

    var isSubscribed: Bool { subscriberCount > 0 }

    /// iOS `.task { await stats.observe() }`: subscribed for the page's lifetime, unsubscribed on cancellation (no
    /// appearance callbacks, 2 c).
    func observe() async {
        subscribe()
        while !Task.isCancelled && isSubscribed {
            await sleep(250.0)
        }
        unsubscribe()
    }

    /// Android `DisposableEffect`: one subscription per composed page.
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

    /// The call is recovering (or offline): keep the last values; resume measuring afterwards with a fresh window.
    func setFrozen(_ frozen: Bool) {
        guard frozen != isFrozen else { return }
        isFrozen = frozen
        previous = nil
    }

    /// A new call session: forget the last call's values.
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
