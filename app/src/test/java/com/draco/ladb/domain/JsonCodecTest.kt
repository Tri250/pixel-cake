package com.draco.ladb.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonCodecTest {
    @Test
    fun `string list roundtrip with special characters`() {
        val items = listOf(
            "plain",
            "with \"quotes\"",
            "back\\slash",
            "new\nline",
            "tab\tchar",
            "unicode 中文 ✓",
            ""
        )

        val encoded = JsonCodec.encodeStringList(items)
        assertEquals(items, JsonCodec.decodeStringList(encoded))
    }

    @Test
    fun `empty list roundtrip`() {
        assertEquals("[]", JsonCodec.encodeStringList(emptyList()))
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList("[]"))
    }

    @Test
    fun `malformed input yields empty list`() {
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList(""))
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList("not json"))
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList("[\"unterminated"))
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList("[\"a\", \"b\""))
        assertEquals(emptyList<String>(), JsonCodec.decodeStringList("[\"a\" \"b\"]"))
    }

    @Test
    fun `map list roundtrip`() {
        val maps = listOf(
            mapOf("port" to "55555", "paired_at" to "1690000000000"),
            mapOf("port" to "39999", "paired_at" to "1690000009999"),
            emptyMap()
        )

        val encoded = JsonCodec.encodeMapList(maps)
        assertEquals(maps, JsonCodec.decodeMapList(encoded))
    }

    @Test
    fun `malformed map input yields empty list`() {
        assertEquals(emptyList<Map<String, String>>(), JsonCodec.decodeMapList("[{\"port\" 55555}]"))
        assertEquals(emptyList<Map<String, String>>(), JsonCodec.decodeMapList("[{]"))
        assertEquals(emptyList<Map<String, String>>(), JsonCodec.decodeMapList("{}"))
    }

    @Test
    fun `escape handles control characters`() {
        assertEquals("\"\\u0001\"", JsonCodec.encodeString("\u0001"))
    }
}
