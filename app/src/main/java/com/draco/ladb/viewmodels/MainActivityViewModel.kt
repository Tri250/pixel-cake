package com.draco.ladb.viewmodels

import android.app.Application
import android.content.Context
import android.net.nsd.NsdManager
import android.os.Build
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import androidx.preference.PreferenceManager
import com.draco.ladb.BuildConfig
import com.draco.ladb.R
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.domain.IntegrityCheck
import com.draco.ladb.domain.IntegrityResult
import com.draco.ladb.utils.ADB
import com.draco.ladb.utils.DnsDiscover
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

class MainActivityViewModel(application: Application) : AndroidViewModel(application) {
    private val _outputText = MutableLiveData<String>()
    val outputText: LiveData<String> = _outputText

    val isPairing = MutableLiveData<Boolean>()

    private var integrityRan = false

    private val settings = SettingsRepository.getInstance(application.applicationContext)
    private val verifiedPrefs = PreferenceManager
        .getDefaultSharedPreferences(application.applicationContext)

    val adb = ADB.getInstance(getApplication<Application>().applicationContext)
    val dnsDiscover =
        DnsDiscover.getInstance(
            application.applicationContext,
            application.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        )

    private val _viewModelHasStartedADB = MutableLiveData(false)
    val viewModelHasStartedADB: LiveData<Boolean> = _viewModelHasStartedADB

    init {
        startOutputThread()
        dnsDiscover.scanAdbPorts()
    }


    fun startADBServer(callback: ((Boolean) -> (Unit))? = null) {
        // Don't start if it's already started.
        if (_viewModelHasStartedADB.value == true || adb.running.value == true) return

        dnsDiscover.strictIpCheck = settings.blockingStrictIpCheck()

        viewModelScope.launch(Dispatchers.IO) {
            val success = adb.initServer()
            if (success) {
                startShellDeathThread()
                _viewModelHasStartedADB.postValue(true)
            }
            callback?.invoke(success)
        }
    }

    /**
     * Verify the install with the Play Integrity API if it is not setup yet
     * (release builds only). Fail-open by design; see [IntegrityCheck].
     */
    fun piracyCheck() {
        if (integrityRan || !BuildConfig.ANTI_PIRACY)
            return

        val key = getApplication<Application>().getString(R.string.pref_key_verified)
        if (verifiedPrefs.getBoolean(key, false))
            return

        integrityRan = true
        IntegrityCheck(getApplication()).verify { result ->
            if (result != IntegrityResult.Failed)
                verifiedPrefs.edit { putBoolean(key, true) }
        }
    }

    /**
     * Continuously update shell output
     */
    private fun startOutputThread() {
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                val out = readOutputFile(adb.outputBufferFile)
                val currentText = _outputText.value
                if (out != currentText)
                    _outputText.postValue(out)
                Thread.sleep(ADB.OUTPUT_BUFFER_DELAY_MS)
            }
        }
    }

    /**
     * Start a death listener to restart the shell once it dies
     */
    private fun startShellDeathThread() {
        viewModelScope.launch(Dispatchers.IO) {
            adb.waitForDeathAndReset()
        }
    }

    /**
     * Erase all shell text
     */
    fun clearOutputText() {
        adb.outputBufferFile.writeText("")
    }

    /**
     * Check if the user should be prompted to pair
     */
    fun needsToPair(): Boolean =
        !settings.blockingPaired() && (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)

    fun setPairedBefore(value: Boolean) {
        viewModelScope.launch {
            settings.setPaired(value)
        }
    }

    /**
     * Remember a successfully paired wireless debugging port
     */
    suspend fun saveDeviceProfile(port: String) = settings.saveDeviceProfile(port)

    /**
     * Read the content of the ABD output file
     */
    private fun readOutputFile(file: File): String {
        val out = ByteArray(adb.getOutputBufferSize())

        synchronized(file) {
            if (!file.exists())
                return ""

            file.inputStream().use {
                val size = it.channel.size()

                if (size <= out.size)
                    return String(it.readBytes())

                val newPos = (it.channel.size() - out.size)
                it.channel.position(newPos)
                it.read(out)
            }
        }

        return String(out)
    }
}
