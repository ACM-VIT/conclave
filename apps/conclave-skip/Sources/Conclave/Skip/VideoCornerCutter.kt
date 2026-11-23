package conclave.module

import android.opengl.GLES20
import org.webrtc.GlShader
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

internal class VideoCornerCutter {
    private var shader: GlShader? = null
    private var positionLocation = 0
    private var localLocation = 0
    private var radiusLocation = 0
    private val vertices: FloatBuffer = ByteBuffer.allocateDirect(VERTEX_COUNT * FLOATS_PER_VERTEX * 4)
        .order(ByteOrder.nativeOrder()).asFloatBuffer()
    private var builtWidth = 0
    private var builtHeight = 0
    private var builtRadius = 0f

    fun cut(surfaceWidth: Int, surfaceHeight: Int, radius: Float) {
        val clamped = VideoCornerGeometry.clampedRadius(surfaceWidth, surfaceHeight, radius)
        if (clamped <= 0f) return
        val program = shader ?: GlShader(VERTEX_SHADER, FRAGMENT_SHADER).also {
            shader = it
            positionLocation = it.getAttribLocation("in_pos")
            localLocation = it.getAttribLocation("in_local")
            radiusLocation = it.getUniformLocation("radius")
        }
        if (surfaceWidth != builtWidth || surfaceHeight != builtHeight || clamped != builtRadius) {
            vertices.clear()
            vertices.put(VideoCornerGeometry.vertices(surfaceWidth, surfaceHeight, clamped))
            builtWidth = surfaceWidth
            builtHeight = surfaceHeight
            builtRadius = clamped
        }
        program.useProgram()
        GLES20.glUniform1f(radiusLocation, clamped)
        vertices.position(0)
        GLES20.glEnableVertexAttribArray(positionLocation)
        GLES20.glVertexAttribPointer(positionLocation, 2, GLES20.GL_FLOAT, false, STRIDE_BYTES, vertices)
        vertices.position(2)
        GLES20.glEnableVertexAttribArray(localLocation)
        GLES20.glVertexAttribPointer(localLocation, 2, GLES20.GL_FLOAT, false, STRIDE_BYTES, vertices)
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_ZERO, GLES20.GL_SRC_ALPHA)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, VERTEX_COUNT)
        GLES20.glDisable(GLES20.GL_BLEND)
        GLES20.glDisableVertexAttribArray(positionLocation)
        GLES20.glDisableVertexAttribArray(localLocation)
    }

    fun release() {
        shader?.release()
        shader = null
    }

    private companion object {
        const val VERTEX_COUNT = VideoCornerGeometry.VERTEX_COUNT
        const val FLOATS_PER_VERTEX = VideoCornerGeometry.FLOATS_PER_VERTEX
        const val STRIDE_BYTES = FLOATS_PER_VERTEX * 4
        const val VERTEX_SHADER = """
attribute vec2 in_pos;
attribute vec2 in_local;
varying vec2 local;
void main() {
  gl_Position = vec4(in_pos, 0.0, 1.0);
  local = in_local;
}
"""
        const val FRAGMENT_SHADER = """
precision mediump float;
varying vec2 local;
uniform float radius;
void main() {
  float coverage = clamp(radius + 0.5 - length(local), 0.0, 1.0);
  gl_FragColor = vec4(0.0, 0.0, 0.0, coverage);
}
"""
    }
}

internal object VideoCornerGeometry {
    const val VERTEX_COUNT = 24
    const val FLOATS_PER_VERTEX = 4

    fun clampedRadius(width: Int, height: Int, radius: Float): Float {
        if (width <= 0 || height <= 0 || radius <= 0f) return 0f
        return minOf(radius, width / 2f, height / 2f)
    }

    fun vertices(width: Int, height: Int, radius: Float): FloatArray {
        val out = FloatArray(VERTEX_COUNT * FLOATS_PER_VERTEX)
        val rx = 2f * radius / width
        val ry = 2f * radius / height
        var offset = 0
        for (corner in 0 until 4) {
            val sx = if (corner % 2 == 0) -1f else 1f
            val sy = if (corner < 2) -1f else 1f
            val outerX = sx
            val outerY = sy
            val innerX = sx - sx * rx
            val innerY = sy - sy * ry
            val quad = floatArrayOf(
                innerX, innerY, 0f, 0f,
                outerX, innerY, radius, 0f,
                innerX, outerY, 0f, radius,
                outerX, outerY, radius, radius,
            )
            for (index in intArrayOf(0, 1, 2, 2, 1, 3)) {
                System.arraycopy(quad, index * FLOATS_PER_VERTEX, out, offset, FLOATS_PER_VERTEX)
                offset += FLOATS_PER_VERTEX
            }
        }
        return out
    }
}
