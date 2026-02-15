//
//  Haptics.swift
//  Conclave
//
//  Haptic feedback manager for iOS
//

#if canImport(UIKit)
import UIKit

enum HapticType {
    case success
    case error
    case warning
    case light
    case medium
    case heavy
}

@MainActor
final class HapticManager {
    static let shared = HapticManager()
    
    private let notificationGenerator = UINotificationFeedbackGenerator()
    private let lightImpactGenerator = UIImpactFeedbackGenerator(style: .light)
    private let mediumImpactGenerator = UIImpactFeedbackGenerator(style: .medium)
    private let heavyImpactGenerator = UIImpactFeedbackGenerator(style: .heavy)
    
    private init() {
        notificationGenerator.prepare()
        lightImpactGenerator.prepare()
        mediumImpactGenerator.prepare()
        heavyImpactGenerator.prepare()
    }
    
    func notification(type: UINotificationFeedbackGenerator.FeedbackType) {
        notificationGenerator.notificationOccurred(type)
        notificationGenerator.prepare()
    }
    
    func impact(style: UIImpactFeedbackGenerator.FeedbackStyle) {
        switch style {
        case .light:
            lightImpactGenerator.impactOccurred()
            lightImpactGenerator.prepare()
        case .medium:
            mediumImpactGenerator.impactOccurred()
            mediumImpactGenerator.prepare()
        case .heavy:
            heavyImpactGenerator.impactOccurred()
            heavyImpactGenerator.prepare()
        default:
            lightImpactGenerator.impactOccurred()
            lightImpactGenerator.prepare()
        }
    }
    
    func trigger(_ type: HapticType) {
        switch type {
        case .success:
            notification(type: .success)
        case .error:
            notification(type: .error)
        case .warning:
            notification(type: .warning)
        case .light:
            impact(style: .light)
        case .medium:
            impact(style: .medium)
        case .heavy:
            impact(style: .heavy)
        }
    }
}
#else
// Stub implementation for non-UIKit platforms

enum HapticType {
    case success
    case error
    case warning
    case light
    case medium
    case heavy
}

@MainActor
final class HapticManager {
    static let shared = HapticManager()
    private init() {}
    func trigger(_ type: HapticType) {
        // No-op on non-UIKit platforms
    }
}
#endif
