package com.draco.ladb.data

import android.annotation.SuppressLint
import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.draco.ladb.domain.DeviceProfile
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/**
 * Single source of truth for user-facing settings, bookmarks, command history,
 * and pairing profiles. Backed by Jetpack DataStore; legacy SharedPreferences
 * values are migrated once on first launch.
 *
 * Blocking accessors are intended for short startup paths only (activity
 * creation, ADB server initialization). Prefer the suspend variants elsewhere.
 */
class SettingsRepository private constructor(private val context: Context) {
    companion object {
        const val KEY_AUTO_SHELL = "auto_shell"
        const val KEY_BUFFER_SIZE = "buffer_size"
        const val KEY_STARTUP_COMMAND = "startup_command"
        const val KEY_PAIRED = "paired"
        const val KEY_BOOKMARKS = "bookmarks"
        const val KEY_HISTORY = "command_history"
        const val KEY_DEVICE_PROFILES = "device_profiles"
        const val KEY_THEME = "theme"
        const val KEY_FONT_SIZE = "font_size"
        const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
        const val KEY_STRICT_IP_CHECK = "strict_ip_check"
        private const val KEY_MIGRATED = "migrated_v2"
        private const val LEGACY_PREFS_NAME = "com.draco.ladb_preferences"
        const val DEFAULT_BUFFER_SIZE = "16384"
        const val DEFAULT_FONT_SIZE = "14"
        const val DEFAULT_STARTUP_COMMAND = "echo 'Success! ※\\(^o^)/※'"

        @Volatile
        @SuppressLint("StaticFieldLeak")
        private var instance: SettingsRepository? = null

        fun getInstance(context: Context): SettingsRepository =
            instance ?: synchronized(this) {
                instance ?: SettingsRepository(context.applicationContext).also { instance = it }
            }
    }

    val data: DataStore<Preferences> = context.dataStore

    init {
        /* Copy legacy SharedPreferences values once, before any read. */
        runBlocking { migrateIfNeeded() }
    }

    /* ---------------- migration ---------------- */

    private suspend fun migrateIfNeeded() {
        val migrated = data.data.first()[booleanPreferencesKey(KEY_MIGRATED)] ?: false
        if (migrated)
            return

        val legacy = context.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
        data.edit { prefs ->
            legacy.all.forEach { (key, value) ->
                when (value) {
                    is Boolean -> prefs[booleanPreferencesKey(key)] = value
                    is String -> prefs[stringPreferencesKey(key)] = value
                    is Set<*> -> prefs[stringSetPreferencesKey(key)] =
                        value.filterIsInstance<String>().toSet()
                }
            }
            prefs[booleanPreferencesKey(KEY_MIGRATED)] = true
        }
    }

    /* ---------------- typed blocking accessors (startup paths) ---------------- */

    fun blockingAutoShell(): Boolean = blocking { it[booleanPreferencesKey(KEY_AUTO_SHELL)] ?: true }
    fun blockingBufferSize(): String = blocking { it[stringPreferencesKey(KEY_BUFFER_SIZE)] ?: DEFAULT_BUFFER_SIZE }
    fun blockingStartupCommand(): String = blocking { it[stringPreferencesKey(KEY_STARTUP_COMMAND)] ?: DEFAULT_STARTUP_COMMAND }
    fun blockingPaired(): Boolean = blocking { it[booleanPreferencesKey(KEY_PAIRED)] ?: false }
    fun blockingTheme(): String = blocking { it[stringPreferencesKey(KEY_THEME)] ?: "system" }
    fun blockingFontSize(): String = blocking { it[stringPreferencesKey(KEY_FONT_SIZE)] ?: DEFAULT_FONT_SIZE }
    fun blockingKeepScreenOn(): Boolean = blocking { it[booleanPreferencesKey(KEY_KEEP_SCREEN_ON)] ?: false }
    fun blockingStrictIpCheck(): Boolean = blocking { it[booleanPreferencesKey(KEY_STRICT_IP_CHECK)] ?: false }
    fun blockingHistory(): String? = blocking { it[stringPreferencesKey(KEY_HISTORY)] }
    fun blockingBookmarks(): Set<String> = blocking { it[stringSetPreferencesKey(KEY_BOOKMARKS)] ?: emptySet() }
    fun blockingLatestPairedPort(): String? = blocking { prefs -> deviceProfiles(prefs).firstOrNull()?.port }
    fun blockingRawString(key: String, defValue: String?): String? = blocking { it[stringPreferencesKey(key)] ?: defValue }
    fun blockingRawBoolean(key: String, defValue: Boolean): Boolean = blocking { it[booleanPreferencesKey(key)] ?: defValue }

    private fun <T> blocking(block: (Preferences) -> T): T = runBlocking { block(data.data.first()) }

    /* ---------------- writes ---------------- */

    suspend fun setPaired(value: Boolean) {
        data.edit { it[booleanPreferencesKey(KEY_PAIRED)] = value }
    }

    fun setPairedBlocking(value: Boolean) = runBlocking { setPaired(value) }

    suspend fun setHistory(raw: String?) {
        val key = stringPreferencesKey(KEY_HISTORY)
        data.edit { prefs ->
            if (raw != null)
                prefs[key] = raw
            else
                prefs.remove(key)
        }
    }

    fun setBookmarksBlocking(value: Set<String>) {
        runBlocking { data.edit { it[stringSetPreferencesKey(KEY_BOOKMARKS)] = value } }
    }

    fun putRawString(key: String, value: String?) {
        val prefKey = stringPreferencesKey(key)
        runBlocking {
            data.edit { prefs ->
                if (value != null)
                    prefs[prefKey] = value
                else
                    prefs.remove(prefKey)
            }
        }
    }

    fun putRawBoolean(key: String, value: Boolean) {
        runBlocking { data.edit { it[booleanPreferencesKey(key)] = value } }
    }

    suspend fun saveDeviceProfile(port: String) {
        data.edit { prefs ->
            val updated = DeviceProfile.withNewProfile(deviceProfiles(prefs), port)
            prefs[stringPreferencesKey(KEY_DEVICE_PROFILES)] = DeviceProfile.encodeAll(updated)
        }
    }

    private fun deviceProfiles(prefs: Preferences): List<DeviceProfile> =
        DeviceProfile.decodeAll(prefs[stringPreferencesKey(KEY_DEVICE_PROFILES)] ?: "[]")
}
