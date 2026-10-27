package conclave.module

import android.content.Context
import android.content.res.Resources

/*
 * S70 SX8: handwritten bridges compile in the Skip library module, which cannot see the app module's R, so
 * app-module drawables (the generated conclave_* glyphs, google_g_mark) and generated colors
 * (sys_notification_accent) are resolved by name, like conclaveStringId in ConclaveStrings.kt. A result of 0
 * means the resource is missing; callers choose a visible fallback. Only legal resource names are looked up, so a
 * qualified "package:type/name" string can never resolve something else.
 *
 * google_g_mark is Google's official multi-color sign-in mark (S70 11 a): draw it with Image, never with Icon,
 * because Icon tints with LocalContentColor and would recolor it.
 */

private val legalResourceName = Regex("[a-z][a-z0-9_]*")

internal fun conclaveDrawableId(context: Context, name: String): Int =
    conclaveResourceId(context.resources, name, "drawable", context.packageName)

internal fun conclaveColorId(context: Context, name: String): Int =
    conclaveResourceId(context.resources, name, "color", context.packageName)

internal fun conclaveResourceId(resources: Resources, name: String, type: String, packageName: String): Int =
    if (legalResourceName.matches(name)) resources.getIdentifier(name, type, packageName) else 0
