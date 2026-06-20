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
