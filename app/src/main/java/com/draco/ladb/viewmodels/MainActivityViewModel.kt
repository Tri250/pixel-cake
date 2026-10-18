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
import java.util.concurrent.atomic.AtomicBoolean

class MainActivityViewModel(application: Application) : AndroidViewModel(application) {
    private val _outputText = MutableLiveData<String>()
    val outputText: LiveData<String> = _outputText

    val isPairing = MutableLiveData<Boolean>()

    private var integrityRan = false

    private val startingServer = AtomicBoolean(false)

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
        /* Apply the strict IP filter before the very first scan starts */
        dnsDiscover.strictIpCheck = settings.blockingStrictIpCheck()

        startOutputThread()
        dnsDiscover.scanAdbPorts()
    }


    fun startADBServer(callback: ((Boolean) -> (Unit))? = null) {
        // Don't start if it's already started. A single start is guaranteed by
        // the CAS below plus ADB.initServer serializing concurrent callers.
        if (adb.running.value == true) return
        if (!startingServer.compareAndSet(false, true)) return

        dnsDiscover.strictIpCheck = settings.blockingStrictIpCheck()

        viewModelScope.launch(Dispatchers.IO) {
            try {
                val success = adb.initServer()
                if (success) {
                    startShellDeathThread()
                    _viewModelHasStartedADB.postValue(true)
                }
                callback?.invoke(success)
            } finally {
                startingServer.set(false)
            }
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
     * Start a death listener to restart the shell once it dies.
     * Only one listener may exist; ADB tracks the armed state.
     */
    private fun startShellDeathThread() {
        if (!adb.armDeathListener())
            return

        viewModelScope.launch(Dispatchers.IO) {
            adb.waitForDeathAndReset()
        }
    }

    /**
     * Erase all shell text
     */
    fun clearOutputText() {
        synchronized(adb.outputBufferFile) {
            adb.outputBufferFile.writeText("")
        }
    }

    /**
     * Check if the user should be prompted to pair
     */
    fun needsToPair(): Boolean =
        settings.blockingAutoShell() &&
            !settings.blockingPaired() &&
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)

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
     * Read the content of the ADB output file
     */
    private fun readOutputFile(file: File): String {
        try {
            synchronized(file) {
                if (!file.exists())
                    return ""

                file.inputStream().use {
                    val size = it.channel.size()
                    val capacity = adb.getOutputBufferSize()

                    if (size <= capacity)
                        return String(it.readBytes())

                    it.channel.position(size - capacity)
                    val out = ByteArray(capacity)
                    var offset = 0
                    while (offset < capacity) {
                        val read = it.read(out, offset, capacity - offset)
                        if (read < 0)
                            break
                        offset += read
                    }
                    return String(out, 0, offset)
                }
            }
        } catch (_: Exception) {
            /* Truncated mid-read (e.g. by clearOutputText); the next cycle
               will pick up a consistent snapshot. */
            return ""
        }
    }
}
