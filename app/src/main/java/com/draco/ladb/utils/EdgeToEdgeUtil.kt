package com.draco.ladb.utils

import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams

/**
 * Shared edge-to-edge plumbing. Android 15 renders content behind the system
 * bars, so each screen has to pad itself; keeping the logic in one place stops
 * the three activities from drifting apart.
 */
object EdgeToEdgeUtil {

    /**
     * Pad [content] by the system bars and size an optional status bar scrim.
     */
    fun applyInsets(content: View, statusBarBackground: View? = null) {
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, windowInsets ->
            val systemBarsInsets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val statusBarInsets = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars())

            v.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                leftMargin = systemBarsInsets.left
                bottomMargin = systemBarsInsets.bottom
                rightMargin = systemBarsInsets.right
                topMargin = systemBarsInsets.top
            }

            statusBarBackground?.updateLayoutParams {
                height = statusBarInsets.top
            }

            WindowInsetsCompat.CONSUMED
        }
    }
}
