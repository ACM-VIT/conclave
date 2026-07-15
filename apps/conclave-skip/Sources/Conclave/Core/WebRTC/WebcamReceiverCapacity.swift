import Foundation

enum WebcamReceiverCapacityProofPolicy {
    static let maximumValidityMs: Int = 5_000
    // Skip's shared Int is a Kotlin Int on Android. Keep the wire value inside
    // the exact range accepted on both native targets.
    static let maximumRevision: Int = 2_147_483_647

    static func isBoundedIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 256
    }

    static func isValidLayer(_ value: Int?) -> Bool {
        guard let value else { return true }
        return value >= 0 && value <= 10
    }
}

enum WebcamReceiverCapacityAuthorityPolicy {
    static func canIngestAtReceipt(
        isForeground: Bool,
        isJoined: Bool,
        isConnected: Bool,
        isIntentionalLeave: Bool
    ) -> Bool {
        isForeground && isJoined && isConnected && !isIntentionalLeave
    }

    static func canIngestAfterHop(
        permittedAtReceipt: Bool,
        capturedGeneration: Int,
        currentGeneration: Int,
        isForeground: Bool,
        isJoined: Bool,
        isConnected: Bool,
        isIntentionalLeave: Bool
    ) -> Bool {
        permittedAtReceipt &&
            capturedGeneration == currentGeneration &&
            canIngestAtReceipt(
                isForeground: isForeground,
                isJoined: isJoined,
                isConnected: isConnected,
                isIntentionalLeave: isIntentionalLeave
            )
    }
}

enum WebcamReceiverCapacityProofBasis: String, Codable {
    case simulcastFullLayer = "simulcast-full-layer"
    case singleLayerTransition = "single-layer-transition"
    case singleLayer = "single-layer"
}

enum WebcamReceiverCapacityReplacementTarget: String, Codable {
    case vp8SingleLayer = "vp8-single-layer"
}

struct WebcamReceiverCapacityReplacementOffer: Codable, Equatable {
    let nonce: String
    let validForMs: Int
    let target: WebcamReceiverCapacityReplacementTarget

    enum CodingKeys: String, CodingKey {
        case nonce
        case validForMs
        case target
    }

    init(
        nonce: String,
        validForMs: Int,
        target: WebcamReceiverCapacityReplacementTarget
    ) {
        self.nonce = nonce
        self.validForMs = validForMs
        self.target = target
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nonce = try container.decode(String.self, forKey: .nonce)
        let validForMs = try container.decode(Int.self, forKey: .validForMs)
        let target = try container.decode(WebcamReceiverCapacityReplacementTarget.self, forKey: .target)
        guard WebcamReceiverCapacityProofPolicy.isBoundedIdentifier(nonce),
              validForMs > 0,
              validForMs <= WebcamReceiverCapacityProofPolicy.maximumValidityMs else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Invalid webcam receiver-capacity replacement offer."
                )
            )
        }
        self.nonce = nonce
        self.validForMs = validForMs
        self.target = target
    }
}

/// Strict server-authored lease. Decoding fails closed for malformed, long-lived,
/// internally inconsistent, or client-invented transition shapes.
struct WebcamReceiverCapacityProofNotification: Codable, Equatable {
    let roomId: String
    let producerId: String
    let revision: Int
    let eligible: Bool
    let validForMs: Int
    let reason: String
    let basis: WebcamReceiverCapacityProofBasis
    let replacementOffer: WebcamReceiverCapacityReplacementOffer?
    let replacesProducerId: String?
    let transitionNonce: String?
    let maxSpatialLayer: Int?
    let maxTemporalLayer: Int?
    let currentSpatialLayer: Int?
    let currentTemporalLayer: Int?
    let score: Double?

    enum CodingKeys: String, CodingKey {
        case roomId
        case producerId
        case revision
        case eligible
        case validForMs
        case reason
        case basis
        case replacementOffer
        case replacesProducerId
        case transitionNonce
        case maxSpatialLayer
        case maxTemporalLayer
        case currentSpatialLayer
        case currentTemporalLayer
        case score
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let roomId = try container.decode(String.self, forKey: .roomId)
        let producerId = try container.decode(String.self, forKey: .producerId)
        let revision = try container.decode(Int.self, forKey: .revision)
        let eligible = try container.decode(Bool.self, forKey: .eligible)
        let validForMs = try container.decode(Int.self, forKey: .validForMs)
        let reason = try container.decode(String.self, forKey: .reason)
        let basis = try container.decode(WebcamReceiverCapacityProofBasis.self, forKey: .basis)
        let replacementOffer = try container.decodeIfPresent(
            WebcamReceiverCapacityReplacementOffer.self,
            forKey: .replacementOffer
        )
        let replacesProducerId = try container.decodeIfPresent(String.self, forKey: .replacesProducerId)
        let transitionNonce = try container.decodeIfPresent(String.self, forKey: .transitionNonce)
        let maxSpatialLayer = try container.decodeIfPresent(Int.self, forKey: .maxSpatialLayer)
        let maxTemporalLayer = try container.decodeIfPresent(Int.self, forKey: .maxTemporalLayer)
        let currentSpatialLayer = try container.decodeIfPresent(Int.self, forKey: .currentSpatialLayer)
        let currentTemporalLayer = try container.decodeIfPresent(Int.self, forKey: .currentTemporalLayer)
        let score = try container.decodeIfPresent(Double.self, forKey: .score)

        let identifiersAreValid =
            WebcamReceiverCapacityProofPolicy.isBoundedIdentifier(roomId) &&
            WebcamReceiverCapacityProofPolicy.isBoundedIdentifier(producerId) &&
            (replacesProducerId == nil || WebcamReceiverCapacityProofPolicy.isBoundedIdentifier(replacesProducerId ?? "")) &&
            (transitionNonce == nil || WebcamReceiverCapacityProofPolicy.isBoundedIdentifier(transitionNonce ?? ""))
        let layersAreValid =
            WebcamReceiverCapacityProofPolicy.isValidLayer(maxSpatialLayer) &&
            WebcamReceiverCapacityProofPolicy.isValidLayer(maxTemporalLayer) &&
            WebcamReceiverCapacityProofPolicy.isValidLayer(currentSpatialLayer) &&
            WebcamReceiverCapacityProofPolicy.isValidLayer(currentTemporalLayer)
        let transitionShapeIsValid: Bool
        if basis == WebcamReceiverCapacityProofBasis.singleLayerTransition {
            transitionShapeIsValid = !eligible || (
                replacesProducerId != nil &&
                transitionNonce != nil
            )
        } else {
            transitionShapeIsValid = replacesProducerId == nil && transitionNonce == nil
        }
        let simulcastShapeIsValid = basis != WebcamReceiverCapacityProofBasis.simulcastFullLayer || !eligible || (
            maxSpatialLayer != nil &&
            maxTemporalLayer != nil &&
            currentSpatialLayer == maxSpatialLayer &&
            currentTemporalLayer == maxTemporalLayer
        )
        let offerShapeIsValid = replacementOffer == nil || (
            basis == WebcamReceiverCapacityProofBasis.simulcastFullLayer && eligible
        )
        let singleLayerFieldsAreValid = !eligible ||
            basis == WebcamReceiverCapacityProofBasis.simulcastFullLayer || (
                maxSpatialLayer == nil &&
                maxTemporalLayer == nil &&
                currentSpatialLayer == nil &&
                currentTemporalLayer == nil
            )
        let eligibleReasonIsValid: Bool
        if !eligible {
            eligibleReasonIsValid = true
        } else {
            switch basis {
            case WebcamReceiverCapacityProofBasis.singleLayerTransition:
                eligibleReasonIsValid = reason == "transition_grace"
            case WebcamReceiverCapacityProofBasis.simulcastFullLayer,
                 WebcamReceiverCapacityProofBasis.singleLayer:
                eligibleReasonIsValid = reason == "qualified"
            }
        }
        let scoreIsValid = score == nil || (
            score?.isFinite == true &&
            (score ?? -1.0) >= 0.0 &&
            (score ?? 11.0) <= 10.0
        )

        guard identifiersAreValid,
              revision >= 0,
              revision <= WebcamReceiverCapacityProofPolicy.maximumRevision,
              validForMs >= 0,
              validForMs <= WebcamReceiverCapacityProofPolicy.maximumValidityMs,
              eligible == (validForMs > 0),
              !reason.isEmpty,
              reason.count <= 64,
              layersAreValid,
              transitionShapeIsValid,
              simulcastShapeIsValid,
              offerShapeIsValid,
              singleLayerFieldsAreValid,
              eligibleReasonIsValid,
              scoreIsValid else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Invalid webcam receiver-capacity proof."
                )
            )
        }

        self.roomId = roomId
        self.producerId = producerId
        self.revision = revision
        self.eligible = eligible
        self.validForMs = validForMs
        self.reason = reason
        self.basis = basis
        self.replacementOffer = replacementOffer
        self.replacesProducerId = replacesProducerId
        self.transitionNonce = transitionNonce
        self.maxSpatialLayer = maxSpatialLayer
        self.maxTemporalLayer = maxTemporalLayer
        self.currentSpatialLayer = currentSpatialLayer
        self.currentTemporalLayer = currentTemporalLayer
        self.score = score
    }
}

struct WebcamReceiverCapacityTransition: Codable, Equatable {
    let fromProducerId: String
    let nonce: String
}

struct ActiveWebcamReceiverCapacityReplacementOffer: Equatable {
    let nonce: String
    let target: WebcamReceiverCapacityReplacementTarget
    let expiresAtMonotonicMs: Double
}

struct ActiveWebcamReceiverCapacityProof: Equatable {
    let roomId: String
    let producerId: String
    let revision: Int
    let basis: WebcamReceiverCapacityProofBasis
    let expiresAtMonotonicMs: Double
    let replacementOffer: ActiveWebcamReceiverCapacityReplacementOffer?
    let replacesProducerId: String?
    let transitionNonce: String?
}

struct WebcamReceiverCapacityProofRevocation: Equatable {
    let roomId: String
    let producerId: String
    let revision: Int
    let basis: WebcamReceiverCapacityProofBasis
    let reason: String
}

struct WebcamReceiverCapacityProofCache {
    private(set) var roomId: String?
    private(set) var latestRevisionByProducer: [String: Int] = [:]
    private(set) var activeByProducer: [String: ActiveWebcamReceiverCapacityProof] = [:]
    private(set) var successorByTransition: [String: ActiveWebcamReceiverCapacityProof] = [:]
    private(set) var revocationByProducer: [String: WebcamReceiverCapacityProofRevocation] = [:]

    init(roomId: String? = nil) {
        self.roomId = roomId
    }

    static func transitionKey(fromProducerId: String, nonce: String) -> String {
        "\(fromProducerId.count):\(fromProducerId):\(nonce)"
    }

    mutating func reset(roomId: String? = nil) {
        self.roomId = roomId
        latestRevisionByProducer.removeAll()
        activeByProducer.removeAll()
        successorByTransition.removeAll()
        revocationByProducer.removeAll()
    }

    @discardableResult
    mutating func apply(
        _ payload: WebcamReceiverCapacityProofNotification,
        expectedRoomId: String,
        nowMonotonicMs: Double
    ) -> Bool {
        guard payload.roomId == expectedRoomId else { return false }
        if roomId != expectedRoomId {
            reset(roomId: expectedRoomId)
        }
        if let latestRevision = latestRevisionByProducer[payload.producerId],
           payload.revision <= latestRevision {
            return false
        }

        latestRevisionByProducer[payload.producerId] = payload.revision
        let stagedKeysForProducer = successorByTransition.compactMap { key, proof in
            proof.producerId == payload.producerId ? key : nil
        }
        for key in stagedKeysForProducer {
            successorByTransition.removeValue(forKey: key)
        }

        if payload.eligible {
            let proof = ActiveWebcamReceiverCapacityProof(
                roomId: payload.roomId,
                producerId: payload.producerId,
                revision: payload.revision,
                basis: payload.basis,
                expiresAtMonotonicMs: nowMonotonicMs + Double(payload.validForMs),
                replacementOffer: payload.replacementOffer.map { offer in
                    ActiveWebcamReceiverCapacityReplacementOffer(
                        nonce: offer.nonce,
                        target: offer.target,
                        expiresAtMonotonicMs: nowMonotonicMs + Double(min(payload.validForMs, offer.validForMs))
                    )
                },
                replacesProducerId: payload.replacesProducerId,
                transitionNonce: payload.transitionNonce
            )
            activeByProducer[payload.producerId] = proof
            revocationByProducer.removeValue(forKey: payload.producerId)
            if proof.basis == .singleLayerTransition,
               let fromProducerId = proof.replacesProducerId,
               let nonce = proof.transitionNonce {
                successorByTransition[Self.transitionKey(fromProducerId: fromProducerId, nonce: nonce)] = proof
            }
        } else {
            activeByProducer.removeValue(forKey: payload.producerId)
            revocationByProducer[payload.producerId] = WebcamReceiverCapacityProofRevocation(
                roomId: payload.roomId,
                producerId: payload.producerId,
                revision: payload.revision,
                basis: payload.basis,
                reason: payload.reason
            )
        }
        return true
    }

    func activeProof(
        roomId: String,
        producerId: String?,
        nowMonotonicMs: Double
    ) -> ActiveWebcamReceiverCapacityProof? {
        guard self.roomId == roomId,
              let producerId,
              let proof = activeByProducer[producerId],
              proof.roomId == roomId,
              nowMonotonicMs < proof.expiresAtMonotonicMs else { return nil }
        return proof
    }

    func stagedSuccessor(
        roomId: String,
        fromProducerId: String,
        nonce: String,
        nowMonotonicMs: Double
    ) -> ActiveWebcamReceiverCapacityProof? {
        guard self.roomId == roomId,
              let proof = successorByTransition[
                Self.transitionKey(fromProducerId: fromProducerId, nonce: nonce)
              ],
              nowMonotonicMs < proof.expiresAtMonotonicMs else { return nil }
        return proof
    }

    func revocation(
        roomId: String,
        producerId: String?
    ) -> WebcamReceiverCapacityProofRevocation? {
        guard self.roomId == roomId, let producerId else { return nil }
        return revocationByProducer[producerId]
    }
}

enum WebcamProducerTopology: String, Equatable {
    case vp8Simulcast = "vp8-simulcast"
    case vp8SingleLayer = "vp8-single-layer"
    case other
}

enum WebcamTopologyTransitionPhase: String, Equatable {
    case adaptive
    case entering
    case awaitingProof = "awaiting-proof"
    case single
    case exiting
}

enum WebcamTopologyReplacementTarget: String, Equatable {
    case adaptiveLayers = "adaptive-layers"
    case singleReceiver = "single-receiver"
}

enum WebcamTopologyReplacementStatus: String, Equatable {
    case applied
    case noop
    case failed
    case superseded
}

struct WebcamTopologyReplacementCommand: Equatable {
    let id: Int
    let target: WebcamTopologyReplacementTarget
    let expectedProducerId: String
    let transition: WebcamReceiverCapacityTransition?
    let forceReplacement: Bool

    init(
        id: Int,
        target: WebcamTopologyReplacementTarget,
        expectedProducerId: String,
        transition: WebcamReceiverCapacityTransition? = nil,
        forceReplacement: Bool = false
    ) {
        self.id = id
        self.target = target
        self.expectedProducerId = expectedProducerId
        self.transition = transition
        self.forceReplacement = forceReplacement
    }
}

struct WebcamTopologyReplacementResult: Equatable {
    let status: WebcamTopologyReplacementStatus
    let producerId: String?
    let topology: WebcamProducerTopology?
    let retryable: Bool
    let ambiguousOrPostCommit: Bool
}

struct WebcamTopologyTransitionInput {
    let nowMonotonicMs: Double
    let producerId: String?
    let producerTopology: WebcamProducerTopology
    let hardSingleReceiverConditionsMet: Bool
    let sourceProofActive: Bool
    let sourceRevocationReason: String?
    let replacementOffer: ActiveWebcamReceiverCapacityReplacementOffer?
    let successorProof: ActiveWebcamReceiverCapacityProof?
    let currentSingleProofActive: Bool
    let currentSingleProofRevocationReason: String?
}

struct WebcamTopologyTransitionState: Equatable {
    var phase: WebcamTopologyTransitionPhase
    var producerId: String?
    var fromProducerId: String?
    var nonce: String?
    var entryCandidateSignature: String?
    var entryCandidateSinceMs: Double?
    var commandId: Int?
    var exitRequested: Bool
    var deadlineMs: Double?
    var exitReason: String?
    var inFlightCommandId: Int?
    var retryAfterMs: Double
    var nextCommandId: Int
    var reentryNotBeforeMs: Double
    var consumedOfferKeys: [String]
    var forceExitReplacement: Bool

    static func initial(nowMonotonicMs: Double = 0.0) -> WebcamTopologyTransitionState {
        WebcamTopologyTransitionState(
            phase: .adaptive,
            producerId: nil,
            fromProducerId: nil,
            nonce: nil,
            entryCandidateSignature: nil,
            entryCandidateSinceMs: nil,
            commandId: nil,
            exitRequested: false,
            deadlineMs: nil,
            exitReason: nil,
            inFlightCommandId: nil,
            retryAfterMs: nowMonotonicMs,
            nextCommandId: 1,
            reentryNotBeforeMs: nowMonotonicMs,
            consumedOfferKeys: [],
            forceExitReplacement: false
        )
    }
}

struct WebcamTopologyTransitionStep {
    let state: WebcamTopologyTransitionState
    let command: WebcamTopologyReplacementCommand?
}

/// Pure scheduling policy shared by the Darwin and Android runtimes. Runtime
/// callers invoke this only after advancing the transition machine, so an
/// already-due deadline has been observed for the current state/command
/// generation. Scheduling it again would create a 1ms wake loop while an entry
/// replacement command is still in flight.
enum WebcamTopologyWakePolicy {
    static func nextWakeAt(
        state: WebcamTopologyTransitionState,
        input: WebcamTopologyTransitionInput,
        currentSingleProofExpiresAtMonotonicMs: Double?
    ) -> Double? {
        var dueAt: Double?
        let includeFuture = { (candidate: Double?) in
            guard let candidate,
                  candidate > input.nowMonotonicMs else { return }
            dueAt = min(dueAt ?? candidate, candidate)
        }

        switch state.phase {
        case .adaptive:
            if let since = state.entryCandidateSinceMs {
                includeFuture(since + WebcamTopologyTransitionMachine.entryStableMs)
                includeFuture(input.replacementOffer?.expiresAtMonotonicMs)
            }
        case .entering, .awaitingProof:
            includeFuture(state.deadlineMs)
        case .single:
            includeFuture(currentSingleProofExpiresAtMonotonicMs)
        case .exiting:
            if state.inFlightCommandId == nil {
                includeFuture(state.retryAfterMs)
            }
        }

        return dueAt
    }
}

enum WebcamTopologyTransitionMachine {
    static let entryStableMs: Double = 1_500.0
    static let reentryCooldownMs: Double = 30_000.0
    static let successorWaitMs: Double = 5_000.0
    static let exitRetryMs: Double = 500.0

    static func latestPending(
        _ existing: WebcamTopologyReplacementCommand?,
        _ next: WebcamTopologyReplacementCommand
    ) -> WebcamTopologyReplacementCommand {
        next
    }

    private static func exactSuccessorProofMatches(
        _ proof: ActiveWebcamReceiverCapacityProof?,
        state: WebcamTopologyTransitionState,
        producerId: String?,
        nowMonotonicMs: Double
    ) -> Bool {
        guard let proof,
              let fromProducerId = state.fromProducerId,
              let nonce = state.nonce else { return false }
        return (producerId == nil || proof.producerId == producerId) &&
            proof.basis == WebcamReceiverCapacityProofBasis.singleLayerTransition &&
            proof.replacesProducerId == fromProducerId &&
            proof.transitionNonce == nonce &&
            nowMonotonicMs < proof.expiresAtMonotonicMs
    }

    private static func adaptiveState(
        from state: WebcamTopologyTransitionState,
        producerId: String?,
        reentryNotBeforeMs: Double? = nil
    ) -> WebcamTopologyTransitionState {
        var next = WebcamTopologyTransitionState.initial(nowMonotonicMs: 0.0)
        next.producerId = producerId
        next.nextCommandId = state.nextCommandId
        next.reentryNotBeforeMs = reentryNotBeforeMs ?? state.reentryNotBeforeMs
        next.consumedOfferKeys = state.consumedOfferKeys
        return next
    }

    private static func beginExit(
        state: WebcamTopologyTransitionState,
        producerId: String,
        reason: String,
        nowMonotonicMs: Double,
        forceReplacement: Bool = false
    ) -> WebcamTopologyTransitionStep {
        let commandId = state.nextCommandId
        var next = state
        next.phase = .exiting
        next.producerId = producerId
        next.fromProducerId = nil
        next.nonce = nil
        next.entryCandidateSignature = nil
        next.entryCandidateSinceMs = nil
        next.commandId = nil
        next.exitRequested = false
        next.deadlineMs = nil
        next.exitReason = reason
        next.inFlightCommandId = commandId
        next.retryAfterMs = nowMonotonicMs
        next.nextCommandId = commandId + 1
        next.forceExitReplacement = forceReplacement
        return WebcamTopologyTransitionStep(
            state: next,
            command: WebcamTopologyReplacementCommand(
                id: commandId,
                target: .adaptiveLayers,
                expectedProducerId: producerId,
                transition: nil,
                forceReplacement: forceReplacement
            )
        )
    }

    static func forceAdaptiveRecovery(
        state: WebcamTopologyTransitionState,
        producerId: String,
        reason: String,
        nowMonotonicMs: Double
    ) -> WebcamTopologyTransitionStep {
        beginExit(
            state: state,
            producerId: producerId,
            reason: reason,
            nowMonotonicMs: nowMonotonicMs,
            forceReplacement: true
        )
    }

    static func advance(
        state: WebcamTopologyTransitionState,
        input: WebcamTopologyTransitionInput
    ) -> WebcamTopologyTransitionStep {
        var next = state

        switch state.phase {
        case .adaptive:
            if let producerId = input.producerId,
               input.producerTopology == .vp8SingleLayer {
                return beginExit(
                    state: state,
                    producerId: producerId,
                    reason: "untracked single-layer producer",
                    nowMonotonicMs: input.nowMonotonicMs
                )
            }

            let offer = input.replacementOffer
            let offerKey = offer.map {
                WebcamReceiverCapacityProofCache.transitionKey(
                    fromProducerId: input.producerId ?? "",
                    nonce: $0.nonce
                )
            }
            let canEnter =
                input.producerId != nil &&
                input.producerTopology == .vp8Simulcast &&
                input.hardSingleReceiverConditionsMet &&
                input.sourceProofActive &&
                offer != nil &&
                input.nowMonotonicMs < (offer?.expiresAtMonotonicMs ?? 0.0) &&
                input.nowMonotonicMs >= state.reentryNotBeforeMs &&
                !(offerKey.map { state.consumedOfferKeys.contains($0) } ?? true)
            guard canEnter,
                  let producerId = input.producerId,
                  let offer,
                  let offerKey else {
                if state.producerId == input.producerId,
                   state.entryCandidateSignature == nil {
                    return WebcamTopologyTransitionStep(state: state, command: nil)
                }
                next = adaptiveState(from: state, producerId: input.producerId)
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }

            if state.entryCandidateSignature != offerKey {
                next.phase = .adaptive
                next.producerId = producerId
                next.entryCandidateSignature = offerKey
                next.entryCandidateSinceMs = input.nowMonotonicMs
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }
            guard input.nowMonotonicMs - (state.entryCandidateSinceMs ?? input.nowMonotonicMs) >= entryStableMs else {
                return WebcamTopologyTransitionStep(state: state, command: nil)
            }

            let commandId = state.nextCommandId
            next.phase = .entering
            next.producerId = producerId
            next.fromProducerId = producerId
            next.nonce = offer.nonce
            next.entryCandidateSignature = nil
            next.entryCandidateSinceMs = nil
            next.commandId = commandId
            next.exitRequested = false
            next.deadlineMs = offer.expiresAtMonotonicMs
            next.nextCommandId = commandId + 1
            next.consumedOfferKeys.append(offerKey)
            return WebcamTopologyTransitionStep(
                state: next,
                command: WebcamTopologyReplacementCommand(
                    id: commandId,
                    target: .singleReceiver,
                    expectedProducerId: producerId,
                    transition: WebcamReceiverCapacityTransition(
                        fromProducerId: producerId,
                        nonce: offer.nonce
                    ),
                    forceReplacement: false
                )
            )

        case .entering:
            let expectedRemoval =
                input.sourceRevocationReason == "producer_removed" ||
                input.sourceRevocationReason == "producer_replaced"
            let sourceBecameUnsafe =
                !input.sourceProofActive &&
                input.sourceRevocationReason != nil &&
                !expectedRemoval
            let offerExpiredWithoutSuccessor =
                state.deadlineMs != nil &&
                input.nowMonotonicMs >= (state.deadlineMs ?? 0.0) &&
                !exactSuccessorProofMatches(
                    input.successorProof,
                    state: state,
                    producerId: nil,
                    nowMonotonicMs: input.nowMonotonicMs
                )
            let shouldExit =
                state.exitRequested ||
                !input.hardSingleReceiverConditionsMet ||
                sourceBecameUnsafe ||
                offerExpiredWithoutSuccessor
            guard shouldExit != state.exitRequested else {
                return WebcamTopologyTransitionStep(state: state, command: nil)
            }
            next.exitRequested = shouldExit
            return WebcamTopologyTransitionStep(state: next, command: nil)

        case .awaitingProof:
            guard input.hardSingleReceiverConditionsMet else {
                return beginExit(
                    state: state,
                    producerId: state.producerId ?? input.producerId ?? "",
                    reason: "single-receiver conditions revoked",
                    nowMonotonicMs: input.nowMonotonicMs
                )
            }
            let successorActive = exactSuccessorProofMatches(
                input.successorProof,
                state: state,
                producerId: state.producerId,
                nowMonotonicMs: input.nowMonotonicMs
            )
            if successorActive || input.currentSingleProofActive {
                next.phase = .single
                next.deadlineMs = nil
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }
            if input.currentSingleProofRevocationReason != nil ||
                input.nowMonotonicMs >= (state.deadlineMs ?? 0.0) {
                return beginExit(
                    state: state,
                    producerId: state.producerId ?? input.producerId ?? "",
                    reason: input.currentSingleProofRevocationReason ?? "successor proof handoff timed out",
                    nowMonotonicMs: input.nowMonotonicMs
                )
            }
            return WebcamTopologyTransitionStep(state: state, command: nil)

        case .single:
            if input.producerId == state.producerId,
               input.producerTopology == .vp8SingleLayer,
               input.hardSingleReceiverConditionsMet,
               input.currentSingleProofActive {
                return WebcamTopologyTransitionStep(state: state, command: nil)
            }
            return beginExit(
                state: state,
                producerId: state.producerId ?? input.producerId ?? "",
                reason: input.currentSingleProofRevocationReason ?? "single-receiver proof or conditions revoked",
                nowMonotonicMs: input.nowMonotonicMs
            )

        case .exiting:
            guard state.inFlightCommandId == nil,
                  input.nowMonotonicMs >= state.retryAfterMs else {
                return WebcamTopologyTransitionStep(state: state, command: nil)
            }
            guard let producerId = input.producerId else {
                next = adaptiveState(
                    from: state,
                    producerId: nil,
                    reentryNotBeforeMs: input.nowMonotonicMs + reentryCooldownMs
                )
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }
            let commandId = state.nextCommandId
            next.producerId = producerId
            next.inFlightCommandId = commandId
            next.nextCommandId = commandId + 1
            return WebcamTopologyTransitionStep(
                state: next,
                command: WebcamTopologyReplacementCommand(
                    id: commandId,
                    target: .adaptiveLayers,
                    expectedProducerId: producerId,
                    transition: nil,
                    forceReplacement: state.forceExitReplacement
                )
            )
        }
    }

    static func settle(
        state: WebcamTopologyTransitionState,
        command: WebcamTopologyReplacementCommand,
        result: WebcamTopologyReplacementResult,
        input: WebcamTopologyTransitionInput
    ) -> WebcamTopologyTransitionStep {
        if state.phase == .entering,
           state.commandId == command.id,
           command.target == .singleReceiver {
            let applied =
                (result.status == .applied || result.status == .noop) &&
                result.producerId != nil &&
                result.topology == .vp8SingleLayer
            guard applied, let producerId = result.producerId else {
                if result.ambiguousOrPostCommit,
                   let recoveryProducerId = result.producerId ?? input.producerId ?? state.fromProducerId {
                    return beginExit(
                        state: state,
                        producerId: recoveryProducerId,
                        reason: "ambiguous single-receiver transition",
                        nowMonotonicMs: input.nowMonotonicMs,
                        forceReplacement: true
                    )
                }
                let next = adaptiveState(
                    from: state,
                    producerId: input.producerId,
                    reentryNotBeforeMs: result.retryable
                        ? input.nowMonotonicMs
                        : input.nowMonotonicMs + reentryCooldownMs
                )
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }

            if state.exitRequested || !input.hardSingleReceiverConditionsMet {
                return beginExit(
                    state: state,
                    producerId: producerId,
                    reason: "conditions changed while entering single-receiver mode",
                    nowMonotonicMs: input.nowMonotonicMs
                )
            }
            let successorMatches =
                exactSuccessorProofMatches(
                    input.successorProof,
                    state: state,
                    producerId: producerId,
                    nowMonotonicMs: input.nowMonotonicMs
                ) ||
                input.currentSingleProofActive
            var next = state
            next.phase = successorMatches ? .single : .awaitingProof
            next.producerId = producerId
            next.commandId = nil
            next.inFlightCommandId = nil
            next.deadlineMs = successorMatches ? nil : input.nowMonotonicMs + successorWaitMs
            return WebcamTopologyTransitionStep(state: next, command: nil)
        }

        if state.phase == .exiting,
           state.inFlightCommandId == command.id,
           command.target == .adaptiveLayers {
            let applied =
                (result.status == .applied || result.status == .noop) &&
                result.producerId != nil &&
                result.topology == .vp8Simulcast
            if applied {
                let next = adaptiveState(
                    from: state,
                    producerId: result.producerId,
                    reentryNotBeforeMs: input.nowMonotonicMs + reentryCooldownMs
                )
                return WebcamTopologyTransitionStep(state: next, command: nil)
            }
            var next = state
            next.producerId = result.producerId ?? input.producerId ?? state.producerId
            next.inFlightCommandId = nil
            next.retryAfterMs = input.nowMonotonicMs + (result.retryable ? exitRetryMs : 2_000.0)
            return WebcamTopologyTransitionStep(state: next, command: nil)
        }

        return WebcamTopologyTransitionStep(state: state, command: nil)
    }
}
