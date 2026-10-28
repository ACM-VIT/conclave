package conclave.module

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

@Composable
internal fun conclaveString(name: String, vararg formatArgs: Any): String {
    val context = LocalContext.current
    val id = remember(context, name) { conclaveStringId(context, name) }
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) stringResource(id) else stringResource(id, *formatArgs)
}

internal fun conclaveStringOf(context: Context, name: String, vararg formatArgs: Any): String {
    val id = conclaveStringId(context, name)
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) context.resources.getString(id) else context.resources.getString(id, *formatArgs)
}

internal fun conclaveStringId(context: Context, name: String): Int =
    context.resources.getIdentifier(name, "string", context.packageName)

@Composable
internal fun conclavePlural(name: String, count: Int, vararg formatArgs: Any): String {
    val context = LocalContext.current
    val id = remember(context, name) { conclavePluralId(context, name) }
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) pluralStringResource(id, count) else pluralStringResource(id, count, *formatArgs)
}

internal fun conclavePluralOf(context: Context, name: String, count: Int, vararg formatArgs: Any): String {
    val id = conclavePluralId(context, name)
    if (id == 0) return "[$name]"
    return if (formatArgs.isEmpty()) context.resources.getQuantityString(id, count)
    else context.resources.getQuantityString(id, count, *formatArgs)
}

internal fun conclavePluralId(context: Context, name: String): Int =
    context.resources.getIdentifier(name, "plurals", context.packageName)
