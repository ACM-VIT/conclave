// Profile material-rounded-24-absolute-v1; manifest SHA256 a8f815b7cd4ceb7bf9c5d04f6fed8528a3cf77981e3994e91cace24d6e25b541; generator SHA256 fbff2029aaba8d8f7b4c982da1566ccbcaa30ddeae11dd629e913ebc03804567.
package conclave.module

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

internal object NativeConvertedIconFixtures {
    private val OppositeWindingCache = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ImageVector.Builder(name = "opposite_winding", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 960f, viewportHeight = 960f, autoMirror = false).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero) {
                moveTo(160.0f, 160.0f)
                lineTo(800.0f, 160.0f)
                lineTo(800.0f, 800.0f)
                lineTo(160.0f, 800.0f)
                close()
                moveTo(320.0f, 320.0f)
                lineTo(320.0f, 640.0f)
                lineTo(640.0f, 640.0f)
                lineTo(640.0f, 320.0f)
                close()
            }
        }.build()
    }
    internal val OppositeWinding: ImageVector get() = OppositeWindingCache.value
    private val SameWindingCache = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ImageVector.Builder(name = "same_winding", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 960f, viewportHeight = 960f, autoMirror = false).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero) {
                moveTo(160.0f, 160.0f)
                lineTo(800.0f, 160.0f)
                lineTo(800.0f, 800.0f)
                lineTo(160.0f, 800.0f)
                close()
                moveTo(320.0f, 320.0f)
                lineTo(640.0f, 320.0f)
                lineTo(640.0f, 640.0f)
                lineTo(320.0f, 640.0f)
                close()
            }
        }.build()
    }
    internal val SameWinding: ImageVector get() = SameWindingCache.value
    private val RelativeAfterCloseCache = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ImageVector.Builder(name = "relative_after_close", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 960f, viewportHeight = 960f, autoMirror = false).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero) {
                moveTo(160.0f, 160.0f)
                lineTo(320.0f, 160.0f)
                lineTo(320.0f, 320.0f)
                lineTo(160.0f, 320.0f)
                close()
                moveTo(480.0f, 480.0f)
                lineTo(640.0f, 480.0f)
                lineTo(640.0f, 640.0f)
                lineTo(480.0f, 640.0f)
                close()
            }
        }.build()
    }
    internal val RelativeAfterClose: ImageVector get() = RelativeAfterCloseCache.value
    private val SmoothQuadraticCache = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ImageVector.Builder(name = "smooth_quadratic", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 960f, viewportHeight = 960f, autoMirror = false).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero) {
                moveTo(160.0f, 480.0f)
                quadTo(320.0f, 160.0f, 480.0f, 480.0f)
                quadTo(640.0f, 800.0f, 800.0f, 480.0f)
                lineTo(800.0f, 800.0f)
                lineTo(160.0f, 800.0f)
                close()
            }
        }.build()
    }
    internal val SmoothQuadratic: ImageVector get() = SmoothQuadraticCache.value
}
