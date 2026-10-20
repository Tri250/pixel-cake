package com.draco.ladb.viewmodels

import android.app.Application
import android.content.Context
import android.net.nsd.NsdManager
import android.os.Build
import android.util.Log
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class MainActivityViewModel(application: Application) : AndroidViewModel(application) {
    private val _outputText = MutableLiveData<String>()
    val outputText: LiveData<String> = _outputText

    val isPairing = MutableLiveData<Boolean>()

    /**
     * True while an actual pairing request is running. Survives configuration
     * changes so a rebuilt activity can tell "still pairing" from "the dialog
     * was lost".
     */
    @Volatile
    var pairingInFlight = false

    private var integrityRan = false

    private val startingServer = AtomicBoolean(false)

    private val settings = SettingsRepository.getInstance(application.applicationContext)
    private val verifiedPrefs = PreferenceManager
        .getDefaultSharedPreferences(application.applicationContext)

    val adb = ADB.getInstance(application.applicationContext)
    val dnsDiscover =
        DnsDiscover.getInstance(
            application.applicationContext,
            application.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        )

    private val _viewModelHasStartedADB = MutableLiveData(false)
    val viewModelHasStartedADB: LiveData<Boolean> = _viewModelHasStartedADB

    /** Size of the buffer file at the last successful read. */
    private var lastObservedSize = -1L

    init {
        /* Apply the strict IP filter before the very first scan starts */
        dnsDiscover.strictIpCheck = settings.blockingStrictIpCheck()

        startOutputThread()

        /* mDNS discovery can fail outright on TV builds and locked-down
           ROMs; the shell still works through the cached port path. */
        try {
            dnsDiscover.scanAdbPorts()
        } catch (t: Throwable) {
            Log.e(TAG, "mDNS discovery unavailable", t)
            adb.debug("mDNS discovery unavailable (${t.message ?: "unknown error"})")
        }
    }


    fun startADBServer(callback: ((Boolean) -> (Unit))? = null) {
        // Don't start if it's already started. A single start is guaranteed by
        // the CAS below plus ADB.initServer serializing concurrent callers.
        if (adb.running.value == true) return
        if (!startingServer.compareAndSet(false, true)) return

        dnsDiscover.strictIpCheck = settings.blockingStrictIpCheck()

        viewModelScope.launch(Dispatchers.IO) {
            try {
                /* initServer never throws, but the guard keeps a Kotlin or
                   runtime error from escaping into an unhandled coroutine
                   exception (which would terminate the process). */
                val success = try {
                    adb.initServer()
                } catch (t: Throwable) {
                    Log.e(TAG, "Unhandled ADB failure", t)
                    adb.debug("ADB crashed while starting: ${t.message ?: t::class.java.simpleName}")
                    false
                }

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

        try {
            IntegrityCheck(getApplication()).verify { result ->
                if (result != IntegrityResult.Failed)
                    verifiedPrefs.edit { putBoolean(key, true) }
            }
        } catch (t: Throwable) {
            /* Integrity is best effort: never block the terminal on it. */
            Log.w(TAG, "Integrity check unavailable", t)
        }
    }

    /**
     * Continuously update shell output
     */
    private fun startOutputThread() {
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                /* null means "nothing changed"; skip the emit entirely. */
                val out = readOutputFile(adb.outputBufferFile)
                if (out != null && out != _outputText.value)
                    _outputText.postValue(out)

                delay(ADB.OUTPUT_BUFFER_DELAY_MS)
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
            try {
                adb.waitForDeathAndReset()
            } catch (t: Throwable) {
                Log.e(TAG, "Death listener stopped", t)
            }
        }
    }

    /**
     * Erase all shell text
     */
    fun clearOutputText() {
        synchronized(adb.outputBufferFile) {
            try {
                adb.outputBufferFile.writeText("")
                lastObservedSize = 0L
                _outputText.postValue("")
            } catch (t: Throwable) {
                Log.w(TAG, "Unable to clear the output buffer", t)
            }
        }

        /* Bring the shell back on a fresh buffer so the terminal keeps
           echoing instead of silently failing on a dead stdin. */
        adb.restartShell()
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
     * Read the content of the ADB output file.
     *
     * Returns null when the file has not changed since the last poll, which
     * keeps the 100 ms refresh loop cheap even with a 1 MB buffer configured.
     */
    private fun readOutputFile(file: File): String? {
        try {
            synchronized(file) {
                if (!file.exists())
                    return ""

                val size = file.length()
                if (size == lastObservedSize)
                    return null

                lastObservedSize = size

                if (size == 0L)
                    return ""

                file.inputStream().use {
                    val capacity = adb.getOutputBufferSize().coerceAtMost(size.toInt())

                    val buffer = ByteArray(capacity)
                    var offset = 0
                    if (capacity < size) {
                        /* Only keep the tail of the file. */
                        it.skip(size - capacity)
                        while (offset < capacity) {
                            val read = it.read(buffer, offset, capacity - offset)
                            if (read < 0) break
                            offset += read
                        }
                    } else {
                        while (offset < capacity) {
                            val read = it.read(buffer, offset, capacity - offset)
                            if (read < 0) break
                            offset += read
                        }
                    }

                    /* Drop a UTF-8 sequence that was cut in half by the
                       buffer window so the terminal never shows mojibake. */
                    var start = 0
                    while (start < offset && (buffer[start].toInt() and 0xC0) == 0x80)
                        start++

                    return String(buffer, start, offset - start, Charsets.UTF_8)
                }
            }
        } catch (t: Throwable) {
            /* Truncated mid-read (e.g. by clearOutputText); the next cycle
               will pick up a consistent snapshot. */
            lastObservedSize = -1L
            return null
        }
    }

    private companion object {
        const val TAG = "MainActivityViewModel"
    }
}
