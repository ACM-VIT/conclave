package conclave.module

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

/*
 * New handwritten Compose strings are Android string resources (owner decision Q14), so translations and the
 * en-XA and ar-XB pseudolocales can reach them. They live in the app module's res/values/strings.xml because
 * the Skip-generated library module has no resource source set, and are resolved by name at run time, the way
 * CallForegroundService.kt resolves the app's notification icon. A missing name shows as "[name]", so a typo is
 * visible instead of silently falling back to English. Shared presenter strings stay in Swift for now.
 */

@Composable
internal fun conclaveString(name: String, vararg formatArgs: Any): String {
    val context = LocalContext.current
    val id = remember(context, name) { conclaveStringId(context, name) }
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) stringResource(id) else stringResource(id, *formatArgs)
}

/** For callbacks outside composition. */
internal fun conclaveStringOf(context: Context, name: String, vararg formatArgs: Any): String {
    val id = conclaveStringId(context, name)
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) context.resources.getString(id) else context.resources.getString(id, *formatArgs)
}

internal fun conclaveStringId(context: Context, name: String): Int =
    context.resources.getIdentifier(name, "string", context.packageName)

/*
 * Plurals (S10 R11; F00 11): <plurals> resources in the app module, resolved by name like strings. The count
 * selects the form; formatArgs fill the placeholders (pass the count again when the text shows it, as
 * pluralStringResource expects). A missing name shows as "[name]". Covered by the en-XA pseudolocale test.
 */

@Composable
internal fun conclavePlural(name: String, count: Int, vararg formatArgs: Any): String {
    val context = LocalContext.current
    val id = remember(context, name) { conclavePluralId(context, name) }
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) pluralStringResource(id, count) else pluralStringResource(id, count, *formatArgs)
}

/** For callbacks outside composition. */
internal fun conclavePluralOf(context: Context, name: String, count: Int, vararg formatArgs: Any): String {
    val id = conclavePluralId(context, name)
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) context.resources.getQuantityString(id, count)
    else context.resources.getQuantityString(id, count, *formatArgs)
}

internal fun conclavePluralId(context: Context, name: String): Int =
    context.resources.getIdentifier(name, "plurals", context.packageName)
