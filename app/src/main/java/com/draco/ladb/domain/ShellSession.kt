package com.draco.ladb.domain

import java.io.File
import java.io.PrintStream

/**
 * Owns the interactive shell process so that process lifecycle logic lives
 * outside of [com.draco.ladb.utils.ADB].
 */
class ShellSession(
    private val workingDir: File,
    private val homeDir: String,
    private val tmpDir: String,
    private val outputBufferFile: File
) {
    private var process: Process? = null

    val isAlive: Boolean
        get() = process?.isAlive == true

    /**
     * Start the shell process, redirecting combined output to the buffer file.
     */
    fun start(command: List<String>, redirect: Boolean): Process {
        val processBuilder = ProcessBuilder(command)
            .directory(workingDir)
            .apply {
                if (redirect) {
                    redirectErrorStream(true)
                    redirectOutput(outputBufferFile)
                }

                environment().apply {
                    put("HOME", homeDir)
                    put("TMPDIR", tmpDir)
                }
            }

        return processBuilder.start().also { process = it }
    }

    /**
     * Pipe a single line into the shell's stdin.
     */
    fun send(message: String) {
        val outputStream = process?.outputStream ?: return
        PrintStream(outputStream).apply {
            println(message)
            flush()
        }
    }

    /**
     * Block until the shell process dies.
     */
    fun awaitDeath() {
        process?.waitFor()
    }

    fun destroy() {
        process?.destroy()
    }

    fun destroyForcibly() {
        process?.destroyForcibly()
    }
}
