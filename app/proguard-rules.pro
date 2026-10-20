# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep stack traces readable in release builds without shipping the mapping
# file to every user: class names are stripped, line numbers survive.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ViewBinding generated classes are inflated by name.
-keepclassmembers class * implements androidx.viewbinding.ViewBinding {
    public static *** inflate(android.view.LayoutInflater);
    public static *** bind(android.view.View);
}

# Preference fragments are created through the framework.
-keep class com.draco.ladb.fragments.HelpPreferenceFragment { <init>(); }

# Quick settings tiles are instantiated by the system.
-keep class com.draco.ladb.services.QSTile { <init>(); }

# ShellSessionState is enum-mirrored into SharedPreferences for the tile.
-keepclassmembers enum com.draco.ladb.domain.ShellSessionState {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
