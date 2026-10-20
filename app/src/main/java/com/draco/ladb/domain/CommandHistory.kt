package com.draco.ladb.domain

/**
 * In-memory command history with JSON serialization for durable storage.
 *
 * JSON is used instead of a newline-delimited payload so that multi-line
 * commands survive a round trip intact.
 */
class CommandHistory(private val maxEntries: Int = DEFAULT_MAX_ENTRIES) {

    private val entries = ArrayDeque<String>()

    /**
     * Restore history from a serialized payload. Blank and malformed
     * entries are ignored; at most [maxEntries] newest commands are kept.
     *
     * Both the current JSON encoding and the legacy newline-delimited
     * encoding are accepted so old installs keep their history.
     */
    fun load(serialized: String?) {
        entries.clear()
        val payload = serialized ?: return
        if (payload.isBlank())
            return

        decodeEntries(payload)
            .takeLast(maxEntries)
            .forEach { entries.addLast(it) }
    }

    private fun decodeEntries(payload: String): List<String> {
        /* Legacy payloads are plain text; JSON payloads start with '['. */
        if (payload.trim().startsWith("[")) {
            val decoded = JsonCodec.decodeStringList(payload)
            if (decoded.isNotEmpty())
                return decoded.map { it.trim() }.filter { it.isNotEmpty() }
            return emptyList()
        }

        return payload
            .split('\n')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
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

    /**
     * Remove every recorded command
     */
    fun clear() {
        entries.clear()
    }

    fun serialize(): String = JsonCodec.encodeStringList(entries.toList())

    companion object {
        const val DEFAULT_MAX_ENTRIES = 50
    }
}
