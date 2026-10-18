package com.draco.ladb.data

import androidx.preference.PreferenceDataStore

/**
 * Bridges androidx.preference to [SettingsRepository] so the settings screen
 * reads from and writes to DataStore transparently.
 */
class SettingsPreferenceDataStore(private val repository: SettingsRepository) : PreferenceDataStore() {
    override fun getString(key: String?, defValue: String?): String? {
        val safeKey = key ?: return defValue
        return repository.blockingRawString(safeKey, defValue)
    }

    override fun putString(key: String?, value: String?) {
        key ?: return
        repository.putRawString(key, value)
    }

    override fun getBoolean(key: String?, defValue: Boolean): Boolean {
        val safeKey = key ?: return defValue
        return repository.blockingRawBoolean(safeKey, defValue)
    }

    override fun putBoolean(key: String?, value: Boolean) {
        key ?: return
        repository.putRawBoolean(key, value)
    }
}
