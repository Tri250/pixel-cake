package com.draco.ladb.data

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
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
 *
 * Every read is fail-safe: storage corruption or an unexpected type change
 * falls back to the default value instead of taking the app down during
 * startup.
 */
class SettingsRepository private constructor(private val context: Context) {
    companion object {
        private const val TAG = "SettingsRepository"

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
        const val DEFAULT_THEME = "system"

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
        try {
            runBlocking { migrateIfNeeded() }
        } catch (t: Throwable) {
            /* A broken migration must never keep the app from starting. */
            Log.e(TAG, "Legacy preference migration failed", t)
        }
    }

    /* ---------------- migration ---------------- */

    private suspend fun migrateIfNeeded() {
        if (data.data.first()[booleanPreferencesKey(KEY_MIGRATED)] == true)
            return

        try {
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
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to migrate legacy preferences", t)
        }
    }

    /* ---------------- typed blocking accessors (startup paths) ---------------- */

    fun blockingAutoShell(): Boolean = blocking(true) { it[booleanPreferencesKey(KEY_AUTO_SHELL)] ?: true }
    fun blockingBufferSize(): String = blocking(DEFAULT_BUFFER_SIZE) { it[stringPreferencesKey(KEY_BUFFER_SIZE)] ?: DEFAULT_BUFFER_SIZE }
    fun blockingStartupCommand(): String = blocking(DEFAULT_STARTUP_COMMAND) { it[stringPreferencesKey(KEY_STARTUP_COMMAND)] ?: DEFAULT_STARTUP_COMMAND }
    fun blockingPaired(): Boolean = blocking(false) { it[booleanPreferencesKey(KEY_PAIRED)] ?: false }
    fun blockingTheme(): String = blocking(DEFAULT_THEME) { it[stringPreferencesKey(KEY_THEME)] ?: DEFAULT_THEME }
    fun blockingFontSize(): String = blocking(DEFAULT_FONT_SIZE) { it[stringPreferencesKey(KEY_FONT_SIZE)] ?: DEFAULT_FONT_SIZE }
    fun blockingKeepScreenOn(): Boolean = blocking(false) { it[booleanPreferencesKey(KEY_KEEP_SCREEN_ON)] ?: false }
    fun blockingStrictIpCheck(): Boolean = blocking(false) { it[booleanPreferencesKey(KEY_STRICT_IP_CHECK)] ?: false }
    fun blockingHistory(): String? = blocking(null) { it[stringPreferencesKey(KEY_HISTORY)] }
    fun blockingBookmarks(): Set<String> = blocking(emptySet()) { it[stringSetPreferencesKey(KEY_BOOKMARKS)] ?: emptySet() }
    fun blockingLatestPairedPort(): String? = blocking(null) { prefs -> deviceProfiles(prefs).firstOrNull()?.port }
    fun blockingRawString(key: String, defValue: String?): String? = blocking(defValue) { it[stringPreferencesKey(key)] ?: defValue }
    fun blockingRawBoolean(key: String, defValue: Boolean): Boolean = blocking(defValue) { it[booleanPreferencesKey(key)] ?: defValue }

    private fun <T> blocking(default: T, block: (Preferences) -> T): T = try {
        runBlocking { block(data.data.first()) }
    } catch (t: Throwable) {
        Log.e(TAG, "Settings read failed, falling back to default", t)
        default
    }

    /* ---------------- writes ---------------- */

    suspend fun setPaired(value: Boolean) {
        data.edit { it[booleanPreferencesKey(KEY_PAIRED)] = value }
    }

    fun setPairedBlocking(value: Boolean) {
        try {
            runBlocking { setPaired(value) }
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to persist paired state", t)
        }
    }

    suspend fun setHistory(raw: String?) {
        val key = stringPreferencesKey(KEY_HISTORY)
        data.edit { prefs ->
            if (raw != null)
                prefs[key] = raw
            else
                prefs.remove(key)
        }
    }

    fun setBookmarks(values: Set<String>) {
        try {
            runBlocking { data.edit { it[stringSetPreferencesKey(KEY_BOOKMARKS)] = values } }
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to persist bookmarks", t)
        }
    }

    fun putRawString(key: String, value: String?) {
        val prefKey = stringPreferencesKey(key)
        try {
            runBlocking {
                data.edit { prefs ->
                    if (value != null)
                        prefs[prefKey] = value
                    else
                        prefs.remove(prefKey)
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to persist preference $key", t)
        }
    }

    fun putRawBoolean(key: String, value: Boolean) {
        try {
            runBlocking { data.edit { it[booleanPreferencesKey(key)] = value } }
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to persist preference $key", t)
        }
    }

    suspend fun saveDeviceProfile(port: String) {
        data.edit { prefs ->
            val updated = DeviceProfile.withNewProfile(deviceProfiles(prefs), port)
            prefs[stringPreferencesKey(KEY_DEVICE_PROFILES)] = DeviceProfile.encodeAll(updated)
        }
    }

    private fun deviceProfiles(prefs: Preferences): List<DeviceProfile> =
        try {
            DeviceProfile.decodeAll(prefs[stringPreferencesKey(KEY_DEVICE_PROFILES)] ?: "[]")
        } catch (t: Throwable) {
            Log.e(TAG, "Corrupt device profiles, resetting", t)
            emptyList()
        }
}
