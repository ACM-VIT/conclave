package conclave.module

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * S60 4 d, j (SET-6) on Android: personal images from the system photo picker (`PickVisualMedia(ImageOnly)`, AND 15.5)
 * decoded with `ImageDecoder` (API 28 decodes HEIF and WebP as well as JPEG and PNG), scaled along the web's output
 * ladder (`EffectsImagePolicy.attempts`) and re-encoded to JPEG in the app container (`filesDir/conclave-effects`), so
 * the default camera formats are never rejected the way the web PNG, JPEG or WebP rule would. "This image format isn't
 * supported." only when decoding fails. Runs on the IO dispatcher; nothing here touches the camera or the network.
 */
internal object EffectsPhotoStore {
    private const val DIRECTORY = "conclave-effects"

    fun directory(context: Context): File = File(context.filesDir, DIRECTORY)

    fun file(context: Context, fileName: String): File = File(directory(context), fileName)

    /** Stores the picked image as `fileName`; `EffectsIssue.none` on success, else the issue to show. */
    suspend fun store(context: Context, uri: Uri, fileName: String, personalCount: Int): EffectsIssue = withContext(Dispatchers.IO) {
        val size = sourceSize(context, uri)
        val early = EffectsImagePolicy.sourceIssue(byteCount = size, personalCount = personalCount)
        if (early != EffectsIssue.none) return@withContext early
        val source = try {
            ImageDecoder.createSource(context.contentResolver, uri)
        } catch (failure: IllegalArgumentException) {
            return@withContext EffectsIssue.format
        }
        var decodedOnce = false
        for (attempt in EffectsImagePolicy.attempts) {
            val bitmap = try {
                ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                    val target = EffectsImagePolicy.outputSize(width = info.size.width, height = info.size.height,
                        maxDimension = attempt.maxDimension)
                    decoder.setTargetSize(target.width, target.height)
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                }
            } catch (failure: ImageDecoder.DecodeException) {
                return@withContext if (decodedOnce) EffectsIssue.decode else EffectsIssue.format
            } catch (failure: IOException) {
                return@withContext EffectsIssue.decode
            }
            decodedOnce = true
            val output = ByteArrayOutputStream()
            val encoded = bitmap.compress(Bitmap.CompressFormat.JPEG, (attempt.quality * 100.0).roundToInt(), output)
            bitmap.recycle()
            if (!encoded) return@withContext EffectsIssue.unavailable
            if (EffectsImagePolicy.fitsEncodedCap(byteCount = output.size())) {
                return@withContext try {
                    directory(context).mkdirs()
                    file(context, fileName).writeBytes(output.toByteArray())
                    EffectsIssue.none
                } catch (failure: IOException) {
                    EffectsIssue.unavailable
                }
            }
        }
        // Decoded, but still over the stored cap at the last step of the ladder.
        EffectsIssue.complex
    }

    fun remove(context: Context, fileName: String) {
        if (fileName.isEmpty()) return
        file(context, fileName).delete()
    }

    /** A stored image decoded at tile size (never the full image, 4 k); null when it cannot be read. */
    suspend fun thumbnail(context: Context, fileName: String, maxPixels: Int): Bitmap? = withContext(Dispatchers.IO) {
        val stored = file(context, fileName)
        if (!stored.exists()) return@withContext null
        try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(stored)) { decoder, info, _ ->
                val target = EffectsImagePolicy.outputSize(width = info.size.width, height = info.size.height, maxDimension = maxPixels)
                decoder.setTargetSize(target.width, target.height)
            }
        } catch (failure: IOException) {
            null
        }
    }

    /** The picked file's byte size, or 0 when the provider does not say (the decoder still applies the other rules). */
    private fun sourceSize(context: Context, uri: Uri): Int {
        return try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                val length = descriptor.length
                if (length < 0) 0 else if (length > Int.MAX_VALUE.toLong()) Int.MAX_VALUE else length.toInt()
            } ?: 0
        } catch (failure: Exception) {
            0
        }
    }
}
