package com.draco.ladb.fragments

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import androidx.preference.*
import com.draco.ladb.R
import com.draco.ladb.data.SettingsPreferenceDataStore
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.utils.ADB
import com.draco.ladb.views.MainActivity
import com.google.android.gms.oss.licenses.OssLicensesMenuActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.system.exitProcess

class HelpPreferenceFragment : PreferenceFragmentCompat() {
    private lateinit var adb: ADB
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    override fun onAttach(context: Context) {
        super.onAttach(context)
        adb = ADB.getInstance(context.applicationContext)
    }

    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
        /* Persist all preference changes to DataStore */
        preferenceManager.preferenceDataStore = SettingsPreferenceDataStore(
            SettingsRepository.getInstance(requireContext().applicationContext)
        )
        setPreferencesFromResource(R.xml.help, rootKey)
    }

    private fun restartApp() {
        val intent = Intent(requireContext(), MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        try {
            startActivity(intent)
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to relaunch the terminal", t)
        }

        requireActivity().finishAffinity()
        mainHandler.postDelayed({ exitProcess(0) }, RESTART_DELAY_MS)
    }

    override fun onPreferenceTreeClick(preference: Preference): Boolean {
        when (preference.key) {
            getString(R.string.unpair_key) -> {
                val repository = SettingsRepository.getInstance(requireContext().applicationContext)
                lifecycleScope.launch(Dispatchers.IO) {
                    repository.setPaired(false)
                    launch(Dispatchers.Main) { restartApp() }
                }
            }

            getString(R.string.restart_key) -> restartApp()
            getString(R.string.tutorial_key) -> openURL(getString(R.string.tutorial_url))

            getString(R.string.developer_key) -> openURL(getString(R.string.developer_url))
            getString(R.string.source_key) -> openURL(getString(R.string.source_url))
            getString(R.string.contact_key) -> openURL(getString(R.string.contact_url))
            getString(R.string.licenses_key) -> {
                val intent = Intent(requireContext(), OssLicensesMenuActivity::class.java)
                startActivity(intent)
            }

            getString(R.string.disclaimer_key) -> MaterialAlertDialogBuilder(requireContext())
                .setTitle(getString(R.string.disclaimer_title))
                .setMessage(getString(R.string.disclaimer_full))
                .setPositiveButton(android.R.string.ok, null)
                .show()

            else -> {
                /* Only plain information rows get an explanation dialog.
                   Anything that opens its own dialog (lists, text entry) must
                   be left alone or two dialogs would stack. */
                if (preference !is DialogPreference &&
                    preference !is SwitchPreference &&
                    preference !is EditTextPreference
                ) {
                    MaterialAlertDialogBuilder(requireContext())
                        .setTitle(preference.title)
                        .setMessage(preference.summary)
                        .show()
                }
            }
        }

        return super.onPreferenceTreeClick(preference)
    }

    /**
     * Open a URL for the user
     */
    private fun openURL(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, url.toUri())
        try {
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Unable to open $url", e)
            Snackbar.make(requireView(), getString(R.string.snackbar_intent_failed), Snackbar.LENGTH_SHORT).show()
        }
    }

    private companion object {
        const val TAG = "HelpPreferenceFragment"
        const val RESTART_DELAY_MS = 250L
    }
}
