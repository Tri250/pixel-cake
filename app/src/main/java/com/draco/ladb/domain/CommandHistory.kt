package com.draco.ladb.domain

/**
 * In-memory command history with newline-based serialization suitable for
 * storage inside a single SharedPreferences String entry.
 */
class CommandHistory(private val maxEntries: Int = DEFAULT_MAX_ENTRIES) {

    private val entries = ArrayDeque<String>()

    /**
     * Restore history from a serialized payload. Blank and malformed
     * entries are ignored; at most [maxEntries] newest commands are kept.
     */
    fun load(serialized: String?) {
        entries.clear()
        serialized
            ?.split('\n')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.takeLast(maxEntries)
            ?.forEach { entries.addLast(it) }
    }

    /**
     * Record a command. Re-recording an existing command moves it to the
     * newest position. Blank commands are ignored.
     */
    fun record(command: String) {
        if (command.isBlank())
            return

        entries.remove(command)
        entries.addLast(command)

        while (entries.size > maxEntries)
            entries.removeFirst()
    }

    fun all(): List<String> = entries.toList()

    fun last(): String? = entries.lastOrNull()

    fun isEmpty(): Boolean = entries.isEmpty()

    fun serialize(): String = entries.joinToString("\n")

    companion object {
        const val DEFAULT_MAX_ENTRIES = 50
    }
}
