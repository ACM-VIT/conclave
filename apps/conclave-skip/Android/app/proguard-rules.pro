# R8's optimization pass miscompiles SkipUI's framework code in release builds —
# e.g. skip.ui.PreferenceValues.collectPreferences dereferences a null
# skip.ui.Preference (NPE in PresentationRoot on sheet/presentation recomposition).
# Disable the optimization pass while keeping the wins that actually matter for
# perf/size: isDebuggable=false (ART optimization), resource shrinking, and
# obfuscation/dead-code shrinking all still apply.
-dontoptimize

-keeppackagenames **
-keep class skip.** { *; }
-keep class tools.skip.** { *; }
-keep class kotlin.jvm.functions.** {*;}
-keep class com.sun.jna.** { *; }
-dontwarn java.awt.**
-keep class * implements com.sun.jna.** { *; }
-keep class * implements skip.bridge.** { *; }
-keep class **._ModuleBundleAccessor_* { *; }
-keep class conclave.module.** { *; }

# mediasoup's bundled WebRTC native library resolves org.webrtc classes from JNI
# during System.loadLibrary; R8 cannot see those references from Java bytecode.
-keep class org.mediasoup.droid.** { *; }
-keep class org.webrtc.** { *; }
-keep interface org.webrtc.** { *; }
-keepclassmembers class * {
    @org.webrtc.CalledByNative *;
    @org.webrtc.CalledByNativeUnchecked *;
}
-keepclasseswithmembers class * {
    native <methods>;
}

# SkipUI's onChange(of:) invokes the two-parameter closure with a null old-value
# on its first evaluation. Kotlin's generated non-null parameter assertions then
# throw ("Parameter specified as non-null is null: … parameter <unused var>"),
# crashing the R8 release build on meeting entry (debug builds don't run R8 so
# they're unaffected). These Intrinsics checks are dev-only assertions; strip
# them for release so the framework's null old-value is tolerated by the closures
# (which ignore it as `_`). Standard release-build optimization.
-assumenosideeffects class kotlin.jvm.internal.Intrinsics {
    public static void checkNotNullParameter(java.lang.Object, java.lang.String);
    public static void checkNotNullParameter(java.lang.Object, java.lang.String, java.lang.String);
    public static void checkParameterIsNotNull(java.lang.Object, java.lang.String);
}
