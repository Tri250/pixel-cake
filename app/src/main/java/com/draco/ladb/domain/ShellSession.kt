package com.draco.ladb.domain

import java.io.File
import java.io.PrintStream
import java.util.concurrent.TimeUnit

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
    @Volatile
    private var process: Process? = null

    /**
     * Lazily created writer bound to the current process stdin. Reused so
     * every keystroke does not allocate a new stream.
     */
    @Volatile
    private var writer: PrintStream? = null

    val isAlive: Boolean
        get() = process?.isAlive == true

    /**
     * Start the shell process, redirecting combined output to the buffer file.
     *
     * Any previous process is terminated first so repeated calls never leak
     * a running child. When [append] is true the redirect opens the buffer in
     * append mode, which keeps a later truncation from producing sparse NUL
     * regions in the file.
     */
    @Synchronized
    fun start(command: List<String>, append: Boolean): Process {
        /* Never orphan a child: terminate the previous shell first. */
        closeWriter()
        try {
            process?.destroy()
        } catch (t: Throwable) {
            /* Ignore: the process may already be gone. */
        }

        val processBuilder = ProcessBuilder(command)
            .directory(workingDir)
            .apply {
                redirectErrorStream(true)
                redirectOutput(
                    if (append) ProcessBuilder.Redirect.appendTo(outputBufferFile)
                    else ProcessBuilder.Redirect.to(outputBufferFile)
                )

                environment().apply {
                    put("HOME", homeDir)
                    put("TMPDIR", tmpDir)
                }
            }

        return processBuilder.start().also {
            process = it
            writer = PrintStream(it.outputStream, true)
        }
    }

    /**
     * Pipe a single line into the shell's stdin.
     */
    fun send(message: String) {
        val stream = writer ?: return
        try {
            stream.println(message)
            stream.flush()
        } catch (t: Throwable) {
            /* The shell died between checks; drop the input. */
            closeWriter()
        }
    }

    /**
     * Block until the shell process dies.
     */
    fun awaitDeath() {
        process?.waitFor()
    }

    /**
     * Block until the shell process dies or [timeout] elapses.
     */
    fun awaitDeath(timeout: Long, unit: TimeUnit) {
        process?.waitFor(timeout, unit)
    }

    fun destroy() {
        closeWriter()
        try {
            process?.destroy()
        } catch (t: Throwable) {
            /* Ignore: the process may already be gone. */
        }
    }

    fun destroyForcibly() {
        closeWriter()
        try {
            process?.destroyForcibly()
        } catch (t: Throwable) {
            /* Ignore: the process may already be gone. */
        }
    }

    /**
     * Close the stdin writer. The process reference is kept so that
     * [awaitDeath] can still observe the terminated child.
     */
    private fun closeWriter() {
        try {
            writer?.close()
        } catch (t: Throwable) {
            /* Ignore */
        }
        writer = null
    }
}
