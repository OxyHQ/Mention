# expo-build-properties' extraProguardRules.
# Readable production stack traces: R8 optimize rewrites line numbers
# when inlining, so without these the traces reaching the Play
# Console point at the wrong code.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# react-native-nitro-modules ships no consumerProguardFiles, and its C++
# layer resolves HybridObjects by name at runtime.
-keep class com.margelo.nitro.** { *; }
-keepclassmembers class * extends com.margelo.nitro.core.HybridObject { *; }

# The prefixed WebRTC 150 jar references livekit.org.jni_zero.JniZeroJni
# without shipping it, and R8 fails the build on the missing class.
-dontwarn livekit.org.jni_zero.JniZeroJni
