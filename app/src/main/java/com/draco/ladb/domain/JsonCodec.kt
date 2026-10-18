package com.draco.ladb.domain

/**
 * Minimal, dependency-free JSON codec for small local documents
 * (bookmark backups, pairing profiles). Pure Kotlin so it is fully
 * unit-testable on the JVM.
 */
object JsonCodec {

    /* ---------------- encoding ---------------- */

    fun encodeString(value: String): String {
        val sb = StringBuilder("\"")
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.append("\"").toString()
    }

    fun encodeStringList(items: List<String>): String =
        items.joinToString(",", "[", "]") { encodeString(it) }

    fun encodeMapList(maps: List<Map<String, String>>): String =
        maps.joinToString(",", "[", "]") { map ->
            map.entries.joinToString(",", "{", "}") { (key, value) ->
                "${encodeString(key)}:${encodeString(value)}"
            }
        }

    /* ---------------- decoding (tolerant: malformed input -> empty) ---------------- */

    fun decodeStringList(json: String): List<String> {
        val parser = Parser(json)
        val items = mutableListOf<String>()

        if (!parser.expect('['))
            return emptyList()
        if (parser.peekIs(']'))
            return items

        while (true) {
            val value = parser.parseString() ?: return emptyList()
            items.add(value)
            when {
                parser.expect(',') -> continue
                parser.expect(']') -> return items
                else -> return emptyList()
            }
        }
    }

    fun decodeMapList(json: String): List<Map<String, String>> {
        val parser = Parser(json)
        val maps = mutableListOf<Map<String, String>>()

        if (!parser.expect('['))
            return emptyList()
        if (parser.peekIs(']'))
            return maps

        while (true) {
            if (!parser.expect('{'))
                return emptyList()

            val map = mutableMapOf<String, String>()
            if (!parser.peekIs('}')) {
                while (true) {
                    val key = parser.parseString() ?: return emptyList()
                    if (!parser.expect(':'))
                        return emptyList()
                    val value = parser.parseString() ?: return emptyList()
                    map[key] = value
                    when {
                        parser.expect(',') -> continue
                        parser.expect('}') -> break
                        else -> return emptyList()
                    }
                }
            } else {
                parser.expect('}')
            }

            maps.add(map)
            when {
                parser.expect(',') -> continue
                parser.expect(']') -> return maps
                else -> return emptyList()
            }
        }
    }

    /* ---------------- parser ---------------- */

    private class Parser(private val input: String) {
        private var pos = 0

        private fun skipWhitespace() {
            while (pos < input.length && input[pos].isWhitespace())
                pos++
        }

        fun peekIs(char: Char): Boolean {
            skipWhitespace()
            return pos < input.length && input[pos] == char
        }

        fun expect(char: Char): Boolean {
            if (!peekIs(char))
                return false
            pos++
            return true
        }

        fun parseString(): String? {
            skipWhitespace()
            if (pos >= input.length || input[pos] != '"')
                return null
            pos++

            val sb = StringBuilder()
            while (pos < input.length) {
                when (val c = input[pos]) {
                    '"' -> {
                        pos++
                        return sb.toString()
                    }
                    '\\' -> {
                        pos++
                        if (pos >= input.length)
                            return null
                        when (val esc = input[pos]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 >= input.length)
                                    return null
                                val hex = input.substring(pos + 1, pos + 5)
                                sb.append(hex.toIntOrNull(16)?.toChar() ?: return null)
                                pos += 4
                            }
                            else -> return null
                        }
                        pos++
                    }
                    else -> {
                        sb.append(c)
                        pos++
                    }
                }
            }
            return null
        }
    }
}
