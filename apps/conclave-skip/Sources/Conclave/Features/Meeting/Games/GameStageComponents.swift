import SwiftUI

// Shared building blocks for the on-stage game surface. Big, tappable, flat:
// solid surfaces, 1 px borders, coral accent only.

/// Kicker + headline + optional support line, the standard top block of a
/// game phase.
struct GameStagePrompt: View {
    var kicker: String? = nil
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let kicker = kicker?.trimmingCharacters(in: .whitespacesAndNewlines),
               !kicker.isEmpty {
                Text(kicker)
                    .font(ACMFont.trial(12, weight: .semibold))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .lineLimit(1)
            }

            Text(title)
                .font(ACMFont.trial(21, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .multilineTextAlignment(.leading)
                .lineLimit(5)

            if let subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines),
               !subtitle.isEmpty {
                Text(subtitle)
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.leading)
                    .lineLimit(4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A large answer/vote card. Selection is coral, reveal states go green/red,
/// and an optional fill ratio paints a flat result bar behind the label.
struct GameStageChoiceCard: View {
    let title: String
    var subtitle: String? = nil
    var trailing: String? = nil
    var isSelected: Bool = false
    var isCorrect: Bool? = nil
    var fillRatio: Double? = nil
    var isDisabled: Bool = false
    let action: () -> Void

    private var resolvedTint: Color {
        if isCorrect == true { return ACMColors.success }
        if isCorrect == false && isSelected { return ACMColors.error }
        if isSelected { return ACMColors.primaryOrange }
        return ACMColors.text
    }

    var body: some View {
        let tint = resolvedTint
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(ACMFont.trial(16, weight: .medium))
                        .foregroundStyle(tint)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                    if let subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !subtitle.isEmpty {
                        Text(subtitle)
                            .font(ACMFont.trial(12))
                            .foregroundStyle(ACMColors.textFaint)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: ACMSpacing.sm)

                if let trailing = trailing?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !trailing.isEmpty {
                    Text(trailing)
                        .font(ACMFont.trial(14, weight: .semibold))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                }

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(tint)
                }
            }
            .padding(.horizontal, ACMSpacing.md)
            .padding(.vertical, 14)
            .frame(minHeight: 56)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { cardBackground(tint: tint) }
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                    .strokeBorder(isSelected ? tint.opacity(0.44) : ACMColors.border, lineWidth: 1)
            }
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled && !isSelected && isCorrect != true ? 0.62 : 1.0)
    }

    private func cardBackground(tint: Color) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                .fill(isSelected ? tint.opacity(0.12) : ACMColors.surfaceRaised)
            if let fillRatio {
                GeometryReader { geometry in
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .fill(tint.opacity(0.10))
                        .frame(width: geometry.size.width * min(1.0, max(0.0, fillRatio)))
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous))
    }
}

/// Full-width primary/secondary action used in the pinned bottom bar.
struct GameStageActionButton: View {
    let title: String
    var isPrimary: Bool = true
    var tint: Color = ACMColors.primaryOrange
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ACMFont.trial(15, weight: .semibold))
                .foregroundStyle(isPrimary ? Color.white : tint)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 48)
                .background(
                    isPrimary ? (isDisabled ? ACMColors.surfaceRaised : tint) : ACMColors.surfaceRaised,
                    in: RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                )
                .overlay {
                    if !isPrimary {
                        RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.6 : 1.0)
    }
}

/// Ranked scores; the leader carries the coral accent.
struct GameStageScoreboard: View {
    let rows: [GameScoreRow]

    var body: some View {
        VStack(spacing: 8) {
            if rows.isEmpty {
                GameStageMetaLine(text: "Scores are not available yet.")
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    GameStageScoreRowView(rank: index + 1, name: row.name, score: row.score)
                }
            }
        }
    }
}

struct GameStageScoreRowView: View {
    let rank: Int
    let name: String
    let score: Int

    private var rankColor: Color {
        switch rank {
        case 1: return ACMColors.primaryOrange
        case 2, 3: return ACMColors.textMuted
        default: return ACMColors.textFaint
        }
    }

    var body: some View {
        let isLeader = rank == 1
        HStack(spacing: ACMSpacing.sm) {
            Text("\(rank)")
                .font(ACMFont.trial(15, weight: .bold))
                .foregroundStyle(rankColor)
                .frame(width: 26, alignment: .center)

            Text(name)
                .font(ACMFont.trial(15, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer(minLength: ACMSpacing.xs)

            Text("\(score)")
                .font(ACMFont.trial(15, weight: .semibold))
                .foregroundStyle(rankColor)
        }
        .padding(.horizontal, ACMSpacing.md)
        .frame(minHeight: 48)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                .fill(isLeader ? ACMColors.primaryOrange.opacity(0.10) : ACMColors.surfaceRaised)
        }
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                .strokeBorder(isLeader ? ACMColors.primaryOrange.opacity(0.34) : ACMColors.border, lineWidth: 1)
        }
    }
}

struct GameStageMetaLine: View {
    let text: String

    var body: some View {
        Text(text)
            .font(ACMFont.trial(12, weight: .medium))
            .foregroundStyle(ACMColors.textFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Centered standalone note for waiting/blocked states.
struct GameStageNotice: View {
    let icon: String
    let androidIcon: String
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(spacing: ACMSpacing.sm) {
            ACMSystemIcon.icon(icon, android: androidIcon, size: 26, tint: "muted")
                .foregroundStyle(ACMColors.textMuted)

            VStack(spacing: 4) {
                Text(title)
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .multilineTextAlignment(.center)

                if let subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !subtitle.isEmpty {
                    Text(subtitle)
                        .font(ACMFont.trial(13))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
            }
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.vertical, ACMSpacing.xl)
        .frame(maxWidth: .infinity)
    }
}

enum GameStageCountdownPolicy {
    static func remainingSeconds(deadline: Double, nowMs: Double, clockOffsetMs: Double) -> Int {
        let remainingMs = deadline - (nowMs + clockOffsetMs)
        return max(0, Int((remainingMs / 1000.0).rounded(.up)))
    }

    static func progress(deadline: Double, durationMs: Double?, nowMs: Double, clockOffsetMs: Double) -> Double? {
        guard let durationMs, durationMs > 0 else { return nil }
        let remainingMs = deadline - (nowMs + clockOffsetMs)
        return min(1.0, max(0.0, remainingMs / durationMs))
    }
}

/// Server-clock countdown: a flat draining bar plus a seconds label. Only this
/// small view re-renders on the tick.
struct GameStageCountdown: View {
    let deadline: Double
    let serverNow: Double
    var durationMs: Double? = nil

    @State private var tick = 0
    @State private var tickerTask: Task<Void, Never>?
    @State private var clockOffsetMs = 0.0

    private var nowMs: Double {
        let _ = tick
        return Date().timeIntervalSince1970 * 1000.0
    }

    var body: some View {
        let now = nowMs
        let seconds = GameStageCountdownPolicy.remainingSeconds(deadline: deadline, nowMs: now, clockOffsetMs: clockOffsetMs)
        let progress = GameStageCountdownPolicy.progress(deadline: deadline, durationMs: durationMs, nowMs: now, clockOffsetMs: clockOffsetMs)

        HStack(spacing: ACMSpacing.sm) {
            if let progress {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(ACMColors.surfaceRaised)
                        Capsule()
                            .fill(seconds <= 5 ? ACMColors.error : ACMColors.primaryOrange)
                            .frame(width: max(6.0, geometry.size.width * progress))
                    }
                }
                .frame(height: 6)
            }

            Text("\(seconds)s")
                .font(ACMFont.trial(13, weight: .semibold))
                .foregroundStyle(seconds <= 5 ? ACMColors.error : ACMColors.textMuted)
                .frame(minWidth: 34, alignment: .trailing)
        }
        .onAppear {
            syncClock()
            startTicker()
        }
        .onDisappear { stopTicker() }
        #if SKIP
        .onChange(of: "\(serverNow)") {
            syncClock()
        }
        #else
        .onChange(of: serverNow) {
            syncClock()
        }
        #endif
    }

    private func syncClock() {
        if serverNow > 0 {
            clockOffsetMs = serverNow - Date().timeIntervalSince1970 * 1000.0
        }
    }

    private func startTicker() {
        stopTicker()
        tickerTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                tick += 1
            }
        }
    }

    private func stopTicker() {
        tickerTask?.cancel()
        tickerTask = nil
    }
}

/// One player identity chip for lobbies: avatar dot + name.
struct GameStagePlayerChip: View {
    let id: String
    let name: String
    var isPending: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            FacehashAvatarView(name: name, id: id, size: 22)

            Text(name)
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(isPending ? ACMColors.textMuted : ACMColors.text)
                .lineLimit(1)

            if isPending {
                Text("next round")
                    .font(ACMFont.trial(10, weight: .medium))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background {
            Capsule().fill(ACMColors.surfaceRaised)
        }
        .overlay {
            Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
        }
    }
}
