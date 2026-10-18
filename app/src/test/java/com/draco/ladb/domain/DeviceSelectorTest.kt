package com.draco.ladb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceSelectorTest {

    @Test
    fun `empty list yields null`() {
        assertNull(DeviceSelector.selectSerial(emptyList()))
    }

    @Test
    fun `single device yields null`() {
        assertNull(DeviceSelector.selectSerial(listOf("1.2.3.4:5555")))
    }

    @Test
    fun `prefers localhost device over others`() {
        val devices = listOf("192.168.1.2:5555", "localhost:5556", "emulator-5554")
        assertEquals("localhost:5556", DeviceSelector.selectSerial(devices))
    }

    @Test
    fun `falls back to first non-emulator device`() {
        val devices = listOf("emulator-5554", "192.168.1.2:5555", "emulator-5556")
        assertEquals("192.168.1.2:5555", DeviceSelector.selectSerial(devices))
    }

    @Test
    fun `last resort is the first device`() {
        val devices = listOf("emulator-5554", "emulator-5556")
        assertEquals("emulator-5554", DeviceSelector.selectSerial(devices))
    }
}
