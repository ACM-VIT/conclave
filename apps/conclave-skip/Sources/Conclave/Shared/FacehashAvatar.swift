import SwiftUI

enum FacehashPresentation {

    static let palette: [Color] = [
        acmColor(red: 249.0, green: 95.0, blue: 74.0),
        acmColor(red: 255.0, green: 0.0, blue: 122.0),
        acmColor(red: 124.0, green: 92.0, blue: 255.0),
        acmColor(red: 45.0, green: 168.0, blue: 168.0),
        acmColor(red: 79.0, green: 134.0, blue: 247.0),
        acmColor(red: 63.0, green: 166.0, blue: 106.0),
        acmColor(red: 245.0, green: 158.0, blue: 11.0),
        acmColor(red: 20.0, green: 184.0, blue: 166.0),
        acmColor(red: 232.0, green: 121.0, blue: 249.0),
        acmColor(red: 56.0, green: 189.0, blue: 248.0),
        acmColor(red: 255.0, green: 138.0, blue: 61.0),
        acmColor(red: 251.0, green: 113.0, blue: 133.0),
        acmColor(red: 192.0, green: 132.0, blue: 252.0),
        acmColor(red: 99.0, green: 102.0, blue: 241.0),
        acmColor(red: 16.0, green: 185.0, blue: 129.0),
        acmColor(red: 255.0, green: 94.0, blue: 174.0),
    ]

    static let faceVariantCount = 4
    static let mouthVariantCount = 10

    static let tongue = acmColor(red: 255.0, green: 143.0, blue: 177.0)

    static func hashValue(for seed: String) -> Int {
        var hash = 0
        #if SKIP

        for unit in seed {
            hash = (hash << 5) - hash + unit.code
        }
        if hash == Int.min { return 0 }
        #else
        for unit in seed.utf16 {
            hash = (hash << 5) - hash + Int(unit)

            hash = ((hash & 0xFFFFFFFF) ^ 0x80000000) - 0x80000000
        }
        #endif
        return abs(hash)
    }

    static func seed(name: String, id: String?) -> String {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedId = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let faceName = trimmedName.isEmpty ? (trimmedId.isEmpty ? "?" : trimmedId) : trimmedName
        return trimmedId.isEmpty ? faceName : "\(faceName):\(trimmedId)"
    }

    static func color(for seed: String) -> Color {
        palette[hashValue(for: seed) % palette.count]
    }

    static func faceIndex(for seed: String) -> Int {
        hashValue(for: seed) % faceVariantCount
    }

    static func mouthIndex(for seed: String) -> Int {
        hashValue(for: "\(seed)|mouth") % mouthVariantCount
    }

    static func faceAspect(for variant: Int) -> CGFloat {
        switch variant {
        case 0: return 63.0 / 15.0
        case 1: return 71.0 / 23.0
        case 2: return 82.0 / 8.0
        default: return 63.0 / 9.0
        }
    }

    static func mouthMetrics(for variant: Int) -> (viewBox: CGSize, widthFraction: CGFloat) {
        switch variant {
        case 0: return (CGSize(width: 32, height: 14), 0.32)
        case 1: return (CGSize(width: 34, height: 20), 0.34)
        case 2: return (CGSize(width: 26, height: 8), 0.24)
        case 3: return (CGSize(width: 32, height: 14), 0.30)
        case 4: return (CGSize(width: 16, height: 18), 0.18)
        case 5: return (CGSize(width: 32, height: 12), 0.30)
        case 6: return (CGSize(width: 32, height: 10), 0.30)
        case 7: return (CGSize(width: 30, height: 14), 0.28)
        case 8: return (CGSize(width: 32, height: 20), 0.30)
        default: return (CGSize(width: 8, height: 8), 0.10)
        }
    }
}

struct FacehashEyesShape: Shape {
    let variant: Int

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch variant {
        case 0:
            roundEyes(into: &path, rect: rect)
        case 1:
            crossEyes(into: &path, rect: rect)
        case 2:
            lineEyes(into: &path, rect: rect)
        default:
            curvedEyes(into: &path, rect: rect)
        }
        return path
    }

    private func roundEyes(into path: inout Path, rect: CGRect) {
        let unit = rect.width / 63.0
        let diameter = 14.4 * unit
        path.addEllipse(in: CGRect(x: rect.minX, y: rect.minY, width: diameter, height: diameter))
        path.addEllipse(in: CGRect(x: rect.minX + 48.0 * unit, y: rect.minY, width: diameter, height: diameter))
    }

    private func crossEyes(into path: inout Path, rect: CGRect) {
        let unit = rect.width / 71.0
        let radius = 3.5 * unit

        func plus(atX x: CGFloat, barX barLeading: CGFloat) {
            path.addRoundedRect(
                in: CGRect(x: rect.minX + x * unit, y: rect.minY, width: 7.0 * unit, height: 23.0 * unit),
                cornerSize: CGSize(width: radius, height: radius)
            )
            path.addRoundedRect(
                in: CGRect(x: rect.minX + barLeading * unit, y: rect.minY + 8.0 * unit, width: 23.0 * unit, height: 7.0 * unit),
                cornerSize: CGSize(width: radius, height: radius)
            )
        }

        plus(atX: 8.0, barX: 0.0)
        plus(atX: 55.2, barX: 47.3)
    }

    private func lineEyes(into path: inout Path, rect: CGRect) {
        let unit = rect.width / 82.0
        let radius = 3.5 * unit
        let height = 6.9 * unit

        func bar(x: CGFloat, width: CGFloat) {
            path.addRoundedRect(
                in: CGRect(x: rect.minX + x * unit, y: rect.minY, width: width * unit, height: height),
                cornerSize: CGSize(width: radius, height: radius)
            )
        }

        bar(x: 0.07, width: 6.9)
        bar(x: 7.9, width: 20.7)
        bar(x: 53.1, width: 20.7)
        bar(x: 74.7, width: 6.9)
    }

    private func curvedEyes(into path: inout Path, rect: CGRect) {
        let unit = rect.width / 63.0
        let radius = 10.5 * unit
        let baseY = rect.minY + 8.6 * unit

        func arch(centerX: CGFloat) {
            path.move(to: CGPoint(x: centerX - radius, y: baseY))
            path.addArc(
                center: CGPoint(x: centerX, y: baseY),
                radius: radius,
                startAngle: .degrees(180),
                endAngle: .degrees(360),
                clockwise: false
            )
            path.closeSubpath()
        }

        arch(centerX: rect.minX + 10.5 * unit)
        arch(centerX: rect.minX + 52.5 * unit)
    }
}

struct FacehashMouthStrokeShape: Shape {
    let variant: Int

    func path(in rect: CGRect) -> Path {
        let metrics = FacehashPresentation.mouthMetrics(for: variant)
        let ux = rect.width / metrics.viewBox.width
        let uy = rect.height / metrics.viewBox.height

        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * ux, y: rect.minY + y * uy)
        }

        var path = Path()
        switch variant {
        case 0:
            path.move(to: point(3, 4))
            path.addQuadCurve(to: point(29, 4), control: point(16, 16))
        case 3:
            path.move(to: point(3, 11))
            path.addQuadCurve(to: point(29, 11), control: point(16, -1))
        case 5:
            path.move(to: point(3, 3))
            path.addQuadCurve(to: point(16, 4), control: point(9, 11))
            path.addQuadCurve(to: point(29, 3), control: point(23, 11))
        case 6:
            path.move(to: point(2, 6))
            path.addQuadCurve(to: point(16, 5), control: point(9, 1))
            path.addQuadCurve(to: point(30, 4), control: point(23, 9))
        case 7:
            path.move(to: point(3, 10))
            path.addQuadCurve(to: point(27, 4), control: point(15, 13))
        default:
            path.move(to: point(3, 4))
            path.addQuadCurve(to: point(29, 4), control: point(16, 15))
        }
        return path
    }
}

struct FacehashMouthFillShape: Shape {
    let variant: Int

    func path(in rect: CGRect) -> Path {
        let metrics = FacehashPresentation.mouthMetrics(for: variant)
        let ux = rect.width / metrics.viewBox.width
        let uy = rect.height / metrics.viewBox.height

        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * ux, y: rect.minY + y * uy)
        }

        var path = Path()
        switch variant {
        case 1:
            path.move(to: point(4, 5))
            path.addQuadCurve(to: point(30, 5), control: point(17, 8))
            path.addQuadCurve(to: point(17, 19), control: point(28, 19))
            path.addQuadCurve(to: point(4, 5), control: point(6, 19))
            path.closeSubpath()
        case 2:
            path.addRoundedRect(
                in: CGRect(x: rect.minX + 2 * ux, y: rect.minY + 2 * uy, width: 22 * ux, height: 4 * uy),
                cornerSize: CGSize(width: 2 * ux, height: 2 * ux)
            )
        case 4:
            path.addEllipse(in: CGRect(
                x: rect.minX + 3.5 * ux,
                y: rect.minY + 3.5 * uy,
                width: 9 * ux,
                height: 11 * uy
            ))
        case 8:
            path.move(to: point(12, 11))
            path.addQuadCurve(to: point(16, 19), control: point(12, 19))
            path.addQuadCurve(to: point(20, 11), control: point(20, 19))
            path.closeSubpath()
        default:
            path.addEllipse(in: CGRect(
                x: rect.minX + 1 * ux,
                y: rect.minY + 1 * uy,
                width: 6 * ux,
                height: 6 * uy
            ))
        }
        return path
    }
}

struct FacehashAvatarView: View {
    let name: String
    var id: String? = nil
    let size: CGFloat

    init(name: String, id: String? = nil, size: CGFloat) {
        self.name = name
        self.id = id
        self.size = size
    }

    var body: some View {
        let seed = FacehashPresentation.seed(name: name, id: id)
        let eyeVariant = FacehashPresentation.faceIndex(for: seed)
        let mouthVariant = FacehashPresentation.mouthIndex(for: seed)
        let eyesWidth = size * 0.6
        let eyesHeight = eyesWidth / FacehashPresentation.faceAspect(for: eyeVariant)
        let mouthMetrics = FacehashPresentation.mouthMetrics(for: mouthVariant)
        let mouthWidth = max(6.0, size * mouthMetrics.widthFraction)
        let mouthHeight = mouthWidth * mouthMetrics.viewBox.height / mouthMetrics.viewBox.width
        let strokeWidth = max(1.4, mouthWidth / 8.0)

        Circle()
            .fill(FacehashPresentation.color(for: seed))
            .frame(width: size, height: size)
            .overlay {
                Circle()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(Color.white.opacity(0.18))
            }
            .overlay {
                VStack(spacing: size * 0.08) {
                    FacehashEyesShape(variant: eyeVariant)
                        .fill(Color.white)
                        .frame(width: eyesWidth, height: eyesHeight)

                    mouth(
                        variant: mouthVariant,
                        width: mouthWidth,
                        height: mouthHeight,
                        strokeWidth: strokeWidth
                    )
                }
            }
    }

    @ViewBuilder
    private func mouth(variant: Int, width: CGFloat, height: CGFloat, strokeWidth: CGFloat) -> some View {
        switch variant {
        case 0, 3, 5, 6, 7:
            FacehashMouthStrokeShape(variant: variant)
                .stroke(Color.white, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round))
                .frame(width: width, height: height)
        case 8:
            ZStack {
                FacehashMouthStrokeShape(variant: variant)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round))
                FacehashMouthFillShape(variant: variant)
                    .fill(FacehashPresentation.tongue)
            }
            .frame(width: width, height: height)
        default:
            FacehashMouthFillShape(variant: variant)
                .fill(Color.white)
                .frame(width: width, height: height)
        }
    }
}
