package com.draco.ladb.fragments

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.preference.*
import com.draco.ladb.R
import com.draco.ladb.data.SettingsPreferenceDataStore
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.utils.ADB
import com.draco.ladb.views.MainActivity
import com.google.android.gms.oss.licenses.OssLicensesMenuActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlin.system.exitProcess

class HelpPreferenceFragment : PreferenceFragmentCompat() {
    private lateinit var adb: ADB

    override fun onAttach(context: Context) {
        super.onAttach(context)
        adb = ADB.getInstance(context)
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
        startActivity(intent)
        requireActivity().finishAffinity()
        exitProcess(0)
    }

    override fun onPreferenceTreeClick(preference: Preference): Boolean {
        when (preference.key) {
            getString(R.string.unpair_key) -> {
                val context = requireContext()
                SettingsRepository.getInstance(context.applicationContext).setPairedBlocking(false)
                restartApp()
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
                if (preference !is SwitchPreference && preference !is EditTextPreference) {
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
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        try {
            startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
            Snackbar.make(requireView(), getString(R.string.snackbar_intent_failed), Snackbar.LENGTH_SHORT).show()
        }
    }
}