package conclave.module

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal object ConclaveAvatarGeometry {

    fun faceAspect(variant: Int): Float = when (variant) {
        0 -> 63f / 15f
        1 -> 71f / 23f
        2 -> 82f / 8f
        else -> 63f / 9f
    }

    data class Mouth(val viewBoxWidth: Float, val viewBoxHeight: Float, val widthFraction: Float)

    fun mouth(variant: Int): Mouth = when (variant) {
        0 -> Mouth(32f, 14f, 0.32f)
        1 -> Mouth(34f, 20f, 0.34f)
        2 -> Mouth(26f, 8f, 0.24f)
        3 -> Mouth(32f, 14f, 0.30f)
        4 -> Mouth(16f, 18f, 0.18f)
        5 -> Mouth(32f, 12f, 0.30f)
        6 -> Mouth(32f, 10f, 0.30f)
        7 -> Mouth(30f, 14f, 0.28f)
        8 -> Mouth(32f, 20f, 0.30f)
        else -> Mouth(8f, 8f, 0.10f)
    }

    fun strokesMouth(variant: Int): Boolean = variant == 0 || variant == 3 || variant == 5 || variant == 6 || variant == 7 || variant == 8

    data class Layout(
        val eyesLeft: Float, val eyesTop: Float, val eyesWidth: Float, val eyesHeight: Float,
        val mouthLeft: Float, val mouthTop: Float, val mouthWidth: Float, val mouthHeight: Float, val strokeWidth: Float,
    )

    fun layout(diameter: Float, faceIndex: Int, mouthIndex: Int, density: Float): Layout {
        val eyesWidth = diameter * 0.6f
        val eyesHeight = eyesWidth / faceAspect(faceIndex)
        val mouth = mouth(mouthIndex)
        val mouthWidth = maxOf(6f * density, diameter * mouth.widthFraction)
        val mouthHeight = mouthWidth * mouth.viewBoxHeight / mouth.viewBoxWidth
        val gap = diameter * 0.08f
        val top = (diameter - (eyesHeight + gap + mouthHeight)) / 2f
        return Layout(
            eyesLeft = (diameter - eyesWidth) / 2f, eyesTop = top, eyesWidth = eyesWidth, eyesHeight = eyesHeight,
            mouthLeft = (diameter - mouthWidth) / 2f, mouthTop = top + eyesHeight + gap, mouthWidth = mouthWidth,
            mouthHeight = mouthHeight, strokeWidth = maxOf(1.4f * density, mouthWidth / 8f),
        )
    }

    fun eyes(variant: Int, left: Float, top: Float, width: Float): Path {
        val path = Path()
        when (variant) {
            0 -> {
                val unit = width / 63f
                val d = 14.4f * unit
                path.addOval(Rect(left, top, left + d, top + d))
                path.addOval(Rect(left + 48f * unit, top, left + 48f * unit + d, top + d))
            }
            1 -> {
                val unit = width / 71f
                val r = CornerRadius(3.5f * unit, 3.5f * unit)
                for ((x, bar) in listOf(8f to 0f, 55.2f to 47.3f)) {
                    path.addRoundRect(RoundRect(left + x * unit, top, left + (x + 7f) * unit, top + 23f * unit, cornerRadius = r))
                    path.addRoundRect(RoundRect(left + bar * unit, top + 8f * unit, left + (bar + 23f) * unit, top + 15f * unit, cornerRadius = r))
                }
            }
            2 -> {
                val unit = width / 82f
                val r = CornerRadius(3.5f * unit, 3.5f * unit)
                for ((x, w) in listOf(0.07f to 6.9f, 7.9f to 20.7f, 53.1f to 20.7f, 74.7f to 6.9f)) {
                    path.addRoundRect(RoundRect(left + x * unit, top, left + (x + w) * unit, top + 6.9f * unit, cornerRadius = r))
                }
            }
            else -> {
                val unit = width / 63f
                val radius = 10.5f * unit
                val baseY = top + 8.6f * unit
                for (cx in listOf(10.5f, 52.5f)) {
                    val center = left + cx * unit
                    path.moveTo(center - radius, baseY)
                    path.arcTo(Rect(center - radius, baseY - radius, center + radius, baseY + radius), 180f, 180f, false)
                    path.close()
                }
            }
        }
        return path
    }

    fun mouthStroke(variant: Int, left: Float, top: Float, width: Float, height: Float): Path {
        val m = mouth(variant)
        val ux = width / m.viewBoxWidth
        val uy = height / m.viewBoxHeight
        fun x(v: Float) = left + v * ux
        fun y(v: Float) = top + v * uy
        val path = Path()
        when (variant) {
            0 -> { path.moveTo(x(3f), y(4f)); path.quadraticTo(x(16f), y(16f), x(29f), y(4f)) }
            3 -> { path.moveTo(x(3f), y(11f)); path.quadraticTo(x(16f), y(-1f), x(29f), y(11f)) }
            5 -> {
                path.moveTo(x(3f), y(3f)); path.quadraticTo(x(9f), y(11f), x(16f), y(4f))
                path.quadraticTo(x(23f), y(11f), x(29f), y(3f))
            }
            6 -> {
                path.moveTo(x(2f), y(6f)); path.quadraticTo(x(9f), y(1f), x(16f), y(5f))
                path.quadraticTo(x(23f), y(9f), x(30f), y(4f))
            }
            7 -> { path.moveTo(x(3f), y(10f)); path.quadraticTo(x(15f), y(13f), x(27f), y(4f)) }
            else -> { path.moveTo(x(3f), y(4f)); path.quadraticTo(x(16f), y(15f), x(29f), y(4f)) }
        }
        return path
    }

    fun mouthFill(variant: Int, left: Float, top: Float, width: Float, height: Float): Path {
        val m = mouth(variant)
        val ux = width / m.viewBoxWidth
        val uy = height / m.viewBoxHeight
        fun x(v: Float) = left + v * ux
        fun y(v: Float) = top + v * uy
        val path = Path()
        when (variant) {
            1 -> {
                path.moveTo(x(4f), y(5f)); path.quadraticTo(x(17f), y(8f), x(30f), y(5f))
                path.quadraticTo(x(28f), y(19f), x(17f), y(19f)); path.quadraticTo(x(6f), y(19f), x(4f), y(5f)); path.close()
            }
            2 -> path.addRoundRect(RoundRect(x(2f), y(2f), x(24f), y(6f), cornerRadius = CornerRadius(2f * ux, 2f * ux)))
            4 -> path.addOval(Rect(x(3.5f), y(3.5f), x(12.5f), y(14.5f)))
            8 -> {
                path.moveTo(x(12f), y(11f)); path.quadraticTo(x(12f), y(19f), x(16f), y(19f))
                path.quadraticTo(x(20f), y(19f), x(20f), y(11f)); path.close()
            }
            else -> path.addOval(Rect(x(1f), y(1f), x(7f), y(7f)))
        }
        return path
    }
}

@Composable
internal fun ConclaveAvatar(
    name: String, id: String?, size: ConclaveAvatarSize, modifier: Modifier = Modifier, standaloneLabel: String? = null,
    identifier: String? = null,
) {
    val identity = remember(name, id) { ConclaveAvatarIdentity.make(name = name, id = id) }
    ConclaveAvatar(identity, size.diameter.dp, modifier, standaloneLabel, identifier)
}

@Composable
internal fun ConclaveAvatar(
    identity: ConclaveAvatarIdentity, diameter: Dp, modifier: Modifier = Modifier, standaloneLabel: String? = null,
    identifier: String? = null,
) {
    val density = LocalDensity.current.density
    val semantics = if (standaloneLabel != null) {
        Modifier.semantics { contentDescription = standaloneLabel; role = Role.Image }
    } else {
        Modifier.semantics { hideFromAccessibility() }
    }
    val tagged = if (identifier != null) modifier.testTag(identifier) else modifier
    val fill = Color(identity.fill)
    val ring = Color(DesignTokens.avatarRing)
    val feature = Color(DesignTokens.neutralWhite)
    val tongue = Color(DesignTokens.avatarTongue)

    Spacer(tagged.size(diameter).then(semantics).drawWithCache {
        val side = size.minDimension
        val layout = ConclaveAvatarGeometry.layout(side, identity.faceIndex, identity.mouthIndex, density)
        val ringWidth = 1f * density
        val mouth = identity.mouthIndex
        val eyes = ConclaveAvatarGeometry.eyes(identity.faceIndex, layout.eyesLeft, layout.eyesTop, layout.eyesWidth)
        val stroke = if (ConclaveAvatarGeometry.strokesMouth(mouth)) {
            ConclaveAvatarGeometry.mouthStroke(mouth, layout.mouthLeft, layout.mouthTop, layout.mouthWidth, layout.mouthHeight)
        } else null
        val filled = if (mouth == 8 || !ConclaveAvatarGeometry.strokesMouth(mouth)) {
            ConclaveAvatarGeometry.mouthFill(mouth, layout.mouthLeft, layout.mouthTop, layout.mouthWidth, layout.mouthHeight)
        } else null
        onDrawBehind {
            drawCircle(fill)
            drawCircle(ring, radius = side / 2f - ringWidth / 2f, center = Offset(side / 2f, side / 2f), style = Stroke(ringWidth))
            drawPath(eyes, feature)
            if (stroke != null) drawPath(stroke, feature, style = Stroke(width = layout.strokeWidth, cap = StrokeCap.Round))
            if (filled != null) drawPath(filled, if (mouth == 8) tongue else feature)
        }
    })
}
