package com.draco.ladb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandHistoryTest {

    @Test
    fun `blank commands are ignored`() {
        val history = CommandHistory()
        history.record("")
        history.record("   ")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `re-recording moves command to newest position`() {
        val history = CommandHistory()
        history.record("ls")
        history.record("pwd")
        history.record("ls")

        assertEquals(listOf("pwd", "ls"), history.all())
    }

    @Test
    fun `oldest entries are evicted beyond capacity`() {
        val history = CommandHistory(maxEntries = 2)
        history.record("a")
        history.record("b")
        history.record("c")

        assertEquals(listOf("b", "c"), history.all())
    }

    @Test
    fun `load ignores blank lines and caps size`() {
        val history = CommandHistory(maxEntries = 2)
        history.load("\na\n\nb\nc\n")

        assertEquals(listOf("b", "c"), history.all())
    }

    @Test
    fun `load handles null and empty payloads`() {
        val history = CommandHistory()
        history.load(null)
        assertTrue(history.isEmpty())
        history.load("")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `serialize and load round trip`() {
        val history = CommandHistory()
        history.record("ls -la")
        history.record("dmesg | tail")

        val restored = CommandHistory()
        restored.load(history.serialize())

        assertEquals(history.all(), restored.all())
        assertEquals("dmesg | tail", restored.last())
    }
}
