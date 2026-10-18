package com.draco.ladb.services

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.preference.PreferenceManager
import com.draco.ladb.R
import com.draco.ladb.utils.ADB
import com.draco.ladb.views.MainActivity

class QSTile : TileService() {
    private companion object {
        const val PREF_QS_CONNECTED = "qs_connected"
    }

    override fun onStartListening() {
        super.onStartListening()
        updateTile()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()

        val connected = PreferenceManager
            .getDefaultSharedPreferences(applicationContext)
            .getBoolean(PREF_QS_CONNECTED, false)

        if (connected) {
            /* Tear down the shell and the ADB server */
            ADB.getInstance(applicationContext).disconnect()
            updateTile()
            return
        }

        val intent = Intent(applicationContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    applicationContext,
                    0,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE
                )
            )
        } else {
            startActivityAndCollapse(intent)
        }
    }

    private fun updateTile() {
        val tile = qsTile ?: return

        val connected = PreferenceManager
            .getDefaultSharedPreferences(applicationContext)
            .getBoolean(PREF_QS_CONNECTED, false)

        tile.state = if (connected) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = getString(
                if (connected) R.string.tile_connected else R.string.tile_disconnected
            )
        }
        tile.updateTile()
    }
}
