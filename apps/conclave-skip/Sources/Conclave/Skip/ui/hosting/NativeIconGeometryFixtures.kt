package conclave.module

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

internal object NativeIconGeometryFixtures {
    private fun fixture(name: String, block: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 960f, 960f).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero, pathBuilder = block)
        }.build()
    val opposite by lazy {
        fixture("hand.opposite_winding") {
            moveTo(160f,160f); lineTo(800f,160f); lineTo(800f,800f); lineTo(160f,800f); close()
            moveTo(320f,320f); lineTo(320f,640f); lineTo(640f,640f); lineTo(640f,320f); close()
        }
    }
    val same by lazy {
        fixture("hand.same_winding") {
            moveTo(160f,160f); lineTo(800f,160f); lineTo(800f,800f); lineTo(160f,800f); close()
            moveTo(320f,320f); lineTo(640f,320f); lineTo(640f,640f); lineTo(320f,640f); close()
        }
    }
    val relative by lazy {
        fixture("hand.relative_after_close") {
            moveTo(160f,160f); lineTo(320f,160f); lineTo(320f,320f); lineTo(160f,320f); close()
            moveTo(480f,480f); lineTo(640f,480f); lineTo(640f,640f); lineTo(480f,640f); close()
        }
    }
    val smooth by lazy {
        fixture("hand.smooth_quadratic") {
            moveTo(160f,480f); quadTo(320f,160f,480f,480f); quadTo(640f,800f,800f,480f)
            lineTo(800f,800f); lineTo(160f,800f); close()
        }
    }
    val hand: List<NativeIconArtwork> = listOf(
        NativeIconArtwork("hand.opposite_winding","OppositeWinding","hand-derived",false) { opposite },
        NativeIconArtwork("hand.same_winding","SameWinding","hand-derived",false) { same },
        NativeIconArtwork("hand.relative_after_close","RelativeAfterClose","hand-derived",false) { relative },
        NativeIconArtwork("hand.smooth_quadratic","SmoothQuadratic","hand-derived",false) { smooth },
    )
    val converted: List<NativeIconArtwork> = listOf(
        NativeIconArtwork("converted.opposite_winding","OppositeWinding","semantic-fixtures.json",false) { NativeConvertedIconFixtures.OppositeWinding },
        NativeIconArtwork("converted.same_winding","SameWinding","semantic-fixtures.json",false) { NativeConvertedIconFixtures.SameWinding },
        NativeIconArtwork("converted.relative_after_close","RelativeAfterClose","semantic-fixtures.json",false) { NativeConvertedIconFixtures.RelativeAfterClose },
        NativeIconArtwork("converted.smooth_quadratic","SmoothQuadratic","semantic-fixtures.json",false) { NativeConvertedIconFixtures.SmoothQuadratic },
    )
}
