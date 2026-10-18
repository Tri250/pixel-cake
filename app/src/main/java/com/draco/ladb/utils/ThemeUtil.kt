package com.draco.ladb.utils

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import com.draco.ladb.data.SettingsRepository

/**
 * Applies the user-selected color scheme (follow system / light / dark)
 * before any activity content is drawn.
 */
object ThemeUtil {
    private const val THEME_SYSTEM = "system"
    private const val THEME_LIGHT = "light"
    private const val THEME_DARK = "dark"

    fun apply(context: Context) {
        val theme = SettingsRepository.getInstance(context.applicationContext).blockingTheme()
        AppCompatDelegate.setDefaultNightMode(
            when (theme) {
                THEME_LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                THEME_DARK -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }
}
