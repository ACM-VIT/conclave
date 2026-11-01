package conclave.module

import android.content.Context
import android.content.res.Resources

private val legalResourceName = Regex("[a-z][a-z0-9_]*")

internal fun conclaveDrawableId(context: Context, name: String): Int =
    conclaveResourceId(context.resources, name, "drawable", context.packageName)

internal fun conclaveColorId(context: Context, name: String): Int =
    conclaveResourceId(context.resources, name, "color", context.packageName)

internal fun conclaveResourceId(resources: Resources, name: String, type: String, packageName: String): Int =
    if (legalResourceName.matches(name)) resources.getIdentifier(name, type, packageName) else 0
