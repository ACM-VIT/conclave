//
//  Models.swift
//  Conclave
//
//  Core data models matching the web client types
//

import Foundation

// MARK: - Connection State

enum ConnectionState: String, Equatable {
    case disconnected
    case connecting
    case connected
    case joining
    case joined
    case reconnecting
    case waiting
    case error
}

// MARK: - Participant

struct Participant: Identifiable, Equatable {
    let id: String
    var userId: String { id }
    var displayName: String?
    var isMuted: Bool = true
    var isCameraOff: Bool = true
    var isHandRaised: Bool = false
    var isGhost: Bool = false
    var isLeaving: Bool = false
    var isScreenSharing: Bool = false
    
    // Tracks are managed separately in WebRTC layer
}

// MARK: - Chat

struct ChatMessage: Identifiable, Equatable {
    let id: String
    let userId: String
    let displayName: String
    let content: String
    let timestamp: Date
    
    init(id: String = UUID().uuidString, userId: String, displayName: String, content: String, timestamp: Date = Date()) {
        self.id = id
        self.userId = userId
        self.displayName = displayName
        self.content = content
        self.timestamp = timestamp
    }
}

// MARK: - Reactions

enum ReactionKind: String, Codable {
    case emoji
    case asset
}

struct Reaction: Identifiable {
    let id: String
    let userId: String
    let kind: ReactionKind
    let value: String
    let label: String?
    let timestamp: Date
    var lane: Int = 0
    
    init(id: String = UUID().uuidString, userId: String, kind: ReactionKind, value: String, label: String? = nil, timestamp: Date = Date()) {
        self.id = id
        self.userId = userId
        self.kind = kind
        self.value = value
        self.label = label
        self.timestamp = timestamp
    }
}

// MARK: - Room

struct Room: Identifiable {
    let id: String
    var userCount: Int
    var isLocked: Bool = false
}

// MARK: - Video Quality

enum VideoQuality: String, Codable {
    case low
    case standard
}

// MARK: - Producer Type

enum ProducerType: String, Codable {
    case webcam
    case screen
}

// MARK: - Video Content Mode
//  Two distinct aspect policies (Meet standard): cameras crop-to-fill, screen
//  shares letterbox on black. Cross-platform (maps to RTCVideoView contentMode
//  on iOS / RendererCommon.ScalingType on Android).

enum VideoContentMode {
    case fill   // scaleAspectFill — cameras (crop to fill, no distortion)
    case fit    // scaleAspectFit — screen-share (letterbox on black)
}

// MARK: - Meet Error

struct MeetError: Error, Equatable {
    enum Code: String {
        case permissionDenied = "PERMISSION_DENIED"
        case connectionFailed = "CONNECTION_FAILED"
        case mediaError = "MEDIA_ERROR"
        case transportError = "TRANSPORT_ERROR"
        case unknown = "UNKNOWN"
    }
    
    let code: Code
    let message: String
    let recoverable: Bool
}
