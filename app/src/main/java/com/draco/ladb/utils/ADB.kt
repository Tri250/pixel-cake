package com.draco.ladb.utils

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.service.quicksettings.TileService
import android.util.Log
import androidx.core.content.edit
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.preference.PreferenceManager
import com.draco.ladb.BuildConfig
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.domain.DeviceSelector
import com.draco.ladb.domain.NativeBinaryCheck
import com.draco.ladb.domain.NativeBinaryStatus
import com.draco.ladb.domain.ShellSession
import com.draco.ladb.domain.ShellSessionState
import com.draco.ladb.services.QSTile
import java.io.BufferedReader
import java.io.File
import java.io.PrintStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration.Companion.seconds

class ADB private constructor(private val context: Context) {
    companion object {
        const val MAX_OUTPUT_BUFFER_SIZE = 1024 * 16
        const val MIN_OUTPUT_BUFFER_SIZE = 1024
        const val MAX_ALLOWED_OUTPUT_BUFFER_SIZE = 1024 * 1024
        const val OUTPUT_BUFFER_DELAY_MS = 100L
        private const val TAG = "ADB"
        private const val PREF_LAST_ADB_PORT = "last_adb_port"
        private const val PREF_QS_CONNECTED = "qs_connected"
        private const val BUFFER_FILE_NAME = "ladb_output.txt"

        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var instance: ADB? = null

        fun getInstance(context: Context): ADB = instance ?: synchronized(this) {
            /* Always pin the application context: a caller may hand us an
               activity or a fragment context. */
            instance ?: ADB(context.applicationContext).also { instance = it }
        }
    }

    private val sharedPrefs = PreferenceManager.getDefaultSharedPreferences(context)

    private val adbPath = "${context.applicationInfo.nativeLibraryDir}/libadb.so"

    /**
     * Is the shell ready to handle commands?
     */
    private val _running = MutableLiveData(false)
    val running: LiveData<Boolean> = _running

    /**
     * Observability: explicit shell session lifecycle state
     */
    private val _state = MutableLiveData(ShellSessionState.IDLE)
    val state: LiveData<ShellSessionState> = _state

    private fun setState(value: ShellSessionState) {
        _state.postValue(value)

        /* Mirror the connection state for the quick settings tile */
        try {
            sharedPrefs.edit {
                putBoolean(PREF_QS_CONNECTED, value == ShellSessionState.READY)
            }
            TileService.requestListeningState(
                context,
                ComponentName(context, QSTile::class.java)
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to refresh quick settings tile", t)
        }
    }

    private var tryingToPair = false

    /**
     * Set when the user explicitly tears the session down (quick settings
     * tile). Prevents the death listener from silently reconnecting.
     */
    @Volatile
    private var manualDisconnect = false

    /**
     * Tracks whether the auto-reset (death listener) loop is running so that
     * concurrent starts never spawn a second one.
     */
    private val deathListenerArmed = AtomicBoolean(false)

    /**
     * Arm the auto-reset loop. Returns false if a listener is already
     * running; disarmed by [disconnect].
     */
    fun armDeathListener(): Boolean = deathListenerArmed.compareAndSet(false, true)

    /**
     * Is the shell closed for any reason?
     */
    private val _closed = MutableLiveData(false)
    val closed: LiveData<Boolean> = _closed

    private val settings = SettingsRepository.getInstance(context)

    /**
     * Where shell output is stored. Lives in the app cache so it is shareable
     * through FileProvider and reclaimed on uninstall.
     */
    val outputBufferFile: File = File(context.cacheDir, BUFFER_FILE_NAME)

    /**
     * The interactive shell process (lifecycle owned by ShellSession)
     */
    private val shellSession = ShellSession(
        workingDir = context.filesDir,
        homeDir = context.filesDir.path,
        tmpDir = context.cacheDir.path,
        outputBufferFile = outputBufferFile
    )

    /**
     * Arguments of the last shell invocation, reused by [restartShell].
     */
    @Volatile
    private var lastShellArgs: List<String> = listOf("shell")

    /**
     * Returns the user buffer size if valid, else the default. The value is
     * clamped because out-of-range input (0, negative, absurdly large) would
     * either blank the terminal or crash the reader on allocation.
     */
    fun getOutputBufferSize(): Int {
        val userValue = settings.blockingBufferSize()
        val parsed = try {
            Integer.parseInt(userValue.trim())
        } catch (_: NumberFormatException) {
            MAX_OUTPUT_BUFFER_SIZE
        }
        return parsed.coerceIn(MIN_OUTPUT_BUFFER_SIZE, MAX_ALLOWED_OUTPUT_BUFFER_SIZE)
    }

    /**
     * Get a list of connected devices. Never throws; returns an empty list
     * when the command times out or cannot run.
     */
    fun getDevices(): List<String> {
        val devicesProcess = try {
            adb(false, listOf("devices"))
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to run adb devices", t)
            return emptyList()
        }

        return try {
            if (!devicesProcess.waitFor(10, TimeUnit.SECONDS))
                devicesProcess.destroyForcibly()

            /* Get result of the command. */
            val linesRaw = BufferedReader(devicesProcess.inputStream.reader()).use {
                it.readLines()
            }

            /* Remove "List of devices attached" line if it exists (it should). */
            linesRaw
                .filterNot { it.contains("List of devices attached") }
                .map { it.split("\t").first() }
                .filter { it.isNotEmpty() }
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to read adb devices", t)
            emptyList()
        } finally {
            devicesProcess.destroyForcibly()
        }
    }

    /**
     * Start the ADB server.
     *
     * Never throws: every failure is reported through [debug] and the return
     * value so a broken environment cannot take the process down.
     */
    fun initServer(): Boolean {
        synchronized(this) {
            if (_running.value == true || tryingToPair)
                return true

            manualDisconnect = false
            tryingToPair = true
        }

        return try {
            initServerInternal()
        } catch (t: Throwable) {
            Log.e(TAG, "ADB server failed to start", t)
            debug("ADB failed to start: ${t.message ?: t::class.java.simpleName}")
            setState(ShellSessionState.DEAD)
            _running.postValue(false)
            tryingToPair = false
            false
        }
    }

    private fun initServerInternal(): Boolean {
        val autoShell = settings.blockingAutoShell()

        val secureSettingsGranted = hasSecureSettingsPermission()

        if (autoShell) {
            reportNativeBinaryHealth()

            if (tryConnectCachedPort()) {
                /* Previous connection still valid; skip discovery entirely. */
                debug("Reusing previous connection...")
            } else {
                /* Only do wireless debugging steps on compatible versions */
                if (secureSettingsGranted) {
                    disableMobileDataAlwaysOn()
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        cycleWirelessDebugging()
                    } else if (!isUSBDebuggingEnabled()) {
                        debug("Turning on USB debugging...")
                        writeGlobalSetting(Settings.Global.ADB_ENABLED, 1)

                        if (!sleepInterruptible(5_000))
                            return false
                    }
                }

                /* Check again... */
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    if (!isWirelessDebuggingEnabled()) {
                        debug("Wireless debugging is not enabled!")
                        debug("Settings -> Developer options -> Wireless debugging")
                        debug("Waiting for wireless debugging...")

                        while (!isWirelessDebuggingEnabled()) {
                            if (!sleepInterruptible(1_000))
                                return false
                        }
                    }
                } else {
                    if (!isUSBDebuggingEnabled()) {
                        debug("USB debugging is not enabled!")
                        debug("Settings -> Developer options -> USB debugging")
                        debug("Waiting for USB debugging...")

                        while (!isUSBDebuggingEnabled()) {
                            if (!sleepInterruptible(1_000))
                                return false
                        }
                    }
                }

                setState(ShellSessionState.DISCOVERING)

                val startTime = System.currentTimeMillis()
                val maxTimeoutTime = startTime + 10.seconds.inWholeMilliseconds
                val minDnsScanTime =
                    (DnsDiscover.aliveTime ?: startTime) + 3.seconds.inWholeMilliseconds
                while (true) {
                    val nowTime = System.currentTimeMillis()
                    val pendingResolves = DnsDiscover.pendingResolves.get()

                    // Wait for pending DNS resolves to finish and the minimum scan time to elapse...
                    if (nowTime >= minDnsScanTime && !pendingResolves) {
                        debug("DNS resolver done...")
                        break
                    }

                    // Or if 10 seconds pass...
                    if (nowTime >= maxTimeoutTime) {
                        debug("DNS resolver took too long! Skipping...")
                        break
                    }

                    debug("Awaiting DNS resolver...")

                    if (!sleepInterruptible(1_000))
                        return false
                }

                val adbPort = DnsDiscover.adbPort
                if (adbPort != null)
                    debug("Best ADB port discovered: $adbPort")
                else
                    debug("No ADB port discovered, fallback...")

                setState(ShellSessionState.CONNECTING)

                debug("Starting ADB server...")
                adb(false, listOf("start-server")).waitFor(1, TimeUnit.MINUTES)

                val waitProcess = if (adbPort != null)
                    adb(false, listOf("connect", "localhost:$adbPort")).waitFor(1, TimeUnit.MINUTES)
                else
                    adb(false, listOf("wait-for-device")).waitFor(1, TimeUnit.MINUTES)

                if (!waitProcess) {
                    debug("Your device didn't connect to LADB")
                    debug("If a reboot doesn't work, please contact support")

                    if (isMobileDataAlwaysOnEnabled()) {
                        debug("Please disable 'Mobile data always on' in Developer Settings!")
                        sleepInterruptible(5_000)
                    }

                    tryingToPair = false
                    return false
                }

                /* Remember the working port to speed up the next startup. */
                if (adbPort != null)
                    saveCachedPort(adbPort)
            }
        }

        val deviceList = getDevices()
        Log.d(TAG, "Devices: $deviceList")

        val argList = if (autoShell) {
            when {
                deviceList.isEmpty() -> {
                    debug("No ADB devices found; falling back to a local shell")
                    listOf("sh", "-l")
                }
                deviceList.size > 1 -> {
                    Log.w(TAG, "Multiple devices detected...")

                    /* Choose the best candidate (local -> non-emulator -> first). */
                    val serialId = DeviceSelector.selectSerial(deviceList) ?: deviceList.first()
                    Log.w(TAG, "Choosing device: $serialId")
                    listOf("-s", serialId, "shell")
                }
                else -> listOf("shell")
            }
        } else {
            listOf("sh", "-l")
        }

        startShell(argList)

        sendToShellProcess("alias adb=\"$adbPath\"")

        if (!secureSettingsGranted) {
            sendToShellProcess("pm grant ${BuildConfig.APPLICATION_ID} android.permission.WRITE_SECURE_SETTINGS &> /dev/null")
        }

        if (argList.lastOrNull() == "shell")
            sendToShellProcess("echo 'Entered adb shell'")
        else
            sendToShellProcess("echo 'Entered non-adb shell'")

        val startupCommand = settings.blockingStartupCommand()
        if (startupCommand.isNotEmpty())
            sendToShellProcess(startupCommand)

        setState(ShellSessionState.READY)
        _running.postValue(true)
        tryingToPair = false

        return true
    }

    /**
     * Start (or restart) the interactive shell, truncating the output buffer
     * while no process owns it. The redirect is opened in append mode so a
     * later buffer clear cannot turn the file into a sparse binary full of
     * NUL bytes.
     */
    private fun startShell(argList: List<String>) {
        lastShellArgs = argList
        synchronized(outputBufferFile) {
            runCatching { outputBufferFile.writeText("") }
        }
        shellSession.start(listOf(adbPath) + argList, append = true)
    }

    /**
     * Drop the current shell and bring up a fresh one on the same target.
     */
    fun restartShell(): Boolean {
        val args = lastShellArgs
        return try {
            shellSession.destroy()
            shellSession.awaitDeath(1, TimeUnit.SECONDS)
            startShell(args)
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to restart the shell", t)
            debug("Shell restart failed: ${t.message ?: t::class.java.simpleName}")
            false
        }
    }

    /**
     * Validate the bundled ADB binary before it is executed so an
     * incompatible build (e.g. 4 KB segments on a 16 KB page kernel) is
     * reported instead of producing a silent launch failure.
     */
    private fun reportNativeBinaryHealth() {
        val status = NativeBinaryCheck.validate(File(adbPath), devicePageSize())
        when (status) {
            is NativeBinaryStatus.Ok -> Unit
            is NativeBinaryStatus.Unusable -> {
                Log.e(TAG, status.reason)
                debug("ADB binary unusable: ${status.reason}")
            }
            is NativeBinaryStatus.PageSizeMismatch -> {
                Log.e(
                    TAG,
                    "ADB binary alignment ${status.alignment} is smaller than the " +
                        "device page size ${status.pageSize}"
                )
                debug("This device uses ${status.pageSize / 1024} KB memory pages.")
                debug("The bundled ADB binary is only ${status.alignment / 1024} KB aligned.")
                debug("Rebuild libadb.so with -Wl,-z,max-page-size=16384 to run here.")
            }
        }
    }

    private fun devicePageSize(): Int {
        return try {
            android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE).toInt()
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to query the page size", t)
            0
        }
    }

    /**
     * Attempt to reconnect using the previously successful port, skipping
     * the slower wireless-debugging discovery path.
     */
    private fun tryConnectCachedPort(): Boolean {
        val lastPort = sharedPrefs.getString(PREF_LAST_ADB_PORT, null) ?: return false

        debug("Trying cached ADB port $lastPort...")
        try {
            adb(false, listOf("start-server")).waitFor(1, TimeUnit.MINUTES)
            adb(false, listOf("connect", "localhost:$lastPort")).waitFor(15, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            Log.w(TAG, "Cached port connect failed", t)
            return false
        }

        val connected = getDevices().any { it.contains("localhost") }
        if (!connected) {
            debug("Cached port no longer valid, falling back to discovery...")
            return false
        }

        return true
    }

    /**
     * Persist the working ADB port for fast reconnects.
     */
    private fun saveCachedPort(port: Int) {
        sharedPrefs.edit {
            putString(PREF_LAST_ADB_PORT, port.toString())
        }
    }

    private fun isWirelessDebuggingEnabled() =
        Settings.Global.getInt(context.contentResolver, "adb_wifi_enabled", 0) == 1

    private fun isUSBDebuggingEnabled() =
        Settings.Global.getInt(context.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1

    private fun isMobileDataAlwaysOnEnabled() =
        Settings.Global.getInt(context.contentResolver, "mobile_data_always_on", 0) == 1

    /**
     * Settings.Global.MOBILE_DATA_ALWAYS_ON creates a bug
     * with the DNS resolver.
     */
    fun disableMobileDataAlwaysOn() {
        if (!hasSecureSettingsPermission())
            return

        // Only turn it off if it's already on.
        if (isMobileDataAlwaysOnEnabled()) {
            debug("Disabling 'Mobile data always on'...")
            writeGlobalSetting("mobile_data_always_on", 0)
            sleepInterruptible(3_000)
        }
    }

    /**
     * Cycles wireless debugging to get a new port to scan.
     *
     * For whatever reason, Wireless Debugging needs to be
     * cycled twice to broadcast a valid port.
     */
    fun cycleWirelessDebugging() {
        if (!hasSecureSettingsPermission())
            return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            debug("Cycling wireless debugging, please wait...")
            // Only turn it off if it's already on.
            if (isWirelessDebuggingEnabled()) {
                debug("Turning off wireless debugging...")
                writeGlobalSetting("adb_wifi_enabled", 0)
                sleepInterruptible(3_000)
            }

            debug("Turning on wireless debugging...")
            writeGlobalSetting("adb_wifi_enabled", 1)
            sleepInterruptible(3_000)

            debug("Turning off wireless debugging...")
            writeGlobalSetting("adb_wifi_enabled", 0)
            sleepInterruptible(3_000)

            debug("Turning on wireless debugging...")
            writeGlobalSetting("adb_wifi_enabled", 1)
            sleepInterruptible(3_000)
        }
    }

    private fun hasSecureSettingsPermission() =
        context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED

    private fun writeGlobalSetting(key: String, value: Int) {
        try {
            Settings.Global.putInt(context.contentResolver, key, value)
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to write $key", t)
            debug("Missing permission to change '$key'; grant WRITE_SECURE_SETTINGS with adb.")
        }
    }

    /**
     * Wait restart the shell once it dies
     */
    fun waitForDeathAndReset() {
        while (!Thread.currentThread().isInterrupted) {
            /* Do not falsely claim the shell is dead if we haven't even initialized it yet */
            if (tryingToPair) {
                /* Avoid busy-waiting while pairing is in progress */
                if (!sleepInterruptible(1_000))
                    return
                continue
            }

            shellSession.awaitDeath()

            /* The user asked to disconnect; do not resurrect the server */
            if (manualDisconnect) {
                debug("Shell closed on purpose; skipping auto-reset")
                return
            }

            if (Thread.currentThread().isInterrupted)
                return

            setState(ShellSessionState.DEAD)
            _running.postValue(false)
            debug("Shell is dead, resetting...")
            try {
                adb(false, listOf("kill-server")).let {
                    if (!it.waitFor(5, TimeUnit.SECONDS))
                        it.destroyForcibly()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "kill-server failed", t)
            }

            if (!sleepInterruptible(3_000))
                return

            try {
                initServer()
            } catch (t: Throwable) {
                Log.e(TAG, "Auto reset failed", t)
            }
        }
    }

    /**
     * Ask the device to pair on Android 11+ devices
     */
    fun pair(port: String, pairingCode: String): Boolean {
        setState(ShellSessionState.PAIRING)

        return try {
            val pairShell = adb(false, listOf("pair", "localhost:$port"))

            /* Sleep to allow shell to catch up */
            sleepInterruptible(5_000)

            /* Pipe pairing code */
            PrintStream(pairShell.outputStream).use {
                it.println(pairingCode)
                it.flush()
            }

            /* Continue once finished pairing (or 10s elapses) */
            pairShell.waitFor(10, TimeUnit.SECONDS)
            pairShell.destroyForcibly().waitFor()

            val killShell = adb(false, listOf("kill-server"))
            killShell.waitFor(3, TimeUnit.SECONDS)
            killShell.destroyForcibly()

            val exit = try {
                pairShell.exitValue()
            } catch (_: IllegalThreadStateException) {
                -1
            }
            exit == 0
        } catch (t: Throwable) {
            Log.e(TAG, "Pairing failed", t)
            false
        }
    }

    /**
     * Send a raw ADB command
     */
    private fun adb(redirect: Boolean, command: List<String>): Process {
        val commandList = command.toMutableList().also {
            it.add(0, adbPath)
        }
        return shell(redirect, commandList)
    }

    /**
     * Send a raw shell command
     */
    private fun shell(redirect: Boolean, command: List<String>): Process {
        val processBuilder = ProcessBuilder(command)
            .directory(context.filesDir)
            .apply {
                if (redirect) {
                    redirectErrorStream(true)
                    redirectOutput(outputBufferFile)
                }

                environment().apply {
                    put("HOME", context.filesDir.path)
                    put("TMPDIR", context.cacheDir.path)
                }
            }

        return processBuilder.start()
    }

    /**
     * Send commands directly to the shell process
     */
    fun sendToShellProcess(msg: String) {
        try {
            shellSession.send(msg)
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to send command to the shell", t)
        }
    }

    /**
     * Tear down the shell and the ADB server (used by the quick settings tile)
     *
     * The state is flipped synchronously so callers (and the tile) observe the
     * change immediately, while the blocking server teardown runs off the main
     * thread to avoid ANRs.
     */
    fun disconnect() {
        manualDisconnect = true
        deathListenerArmed.set(false)
        setState(ShellSessionState.IDLE)
        _running.postValue(false)

        Thread {
            shellSession.destroy()

            try {
                adb(false, listOf("kill-server")).let {
                    if (!it.waitFor(5, TimeUnit.SECONDS))
                        it.destroyForcibly()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "kill-server failed", t)
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * Write a debug message to the user
     */
    fun debug(msg: String) {
        synchronized(outputBufferFile) {
            Log.d(TAG, msg)
            try {
                if (outputBufferFile.exists())
                    outputBufferFile.appendText("* $msg" + System.lineSeparator())
            } catch (t: Throwable) {
                Log.w(TAG, "Unable to write debug output", t)
            }
        }
    }

    /**
     * Sleep that honours interruption so cancelled work stops immediately
     * instead of finishing a minute-long wait.
     *
     * @return false when the thread was interrupted.
     */
    private fun sleepInterruptible(ms: Long): Boolean {
        return try {
            Thread.sleep(ms)
            !Thread.currentThread().isInterrupted
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }
}
