package com.draco.ladb.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProfileTest {
    @Test
    fun `encode decode roundtrip`() {
        val profiles = listOf(
            DeviceProfile("55555", 1690000000000L),
            DeviceProfile("39999", 1L)
        )

        assertEquals(profiles, DeviceProfile.decodeAll(DeviceProfile.encodeAll(profiles)))
    }

    @Test
    fun `decode malformed input yields empty list`() {
        assertEquals(emptyList<DeviceProfile>(), DeviceProfile.decodeAll("garbage"))
        assertEquals(emptyList<DeviceProfile>(), DeviceProfile.decodeAll("[]"))
    }

    @Test
    fun `decode tolerates missing paired_at`() {
        assertEquals(
            listOf(DeviceProfile("55555", 0L)),
            DeviceProfile.decodeAll("[{\"port\":\"55555\"}]")
        )
    }

    @Test
    fun `withNewProfile promotes dedupes and caps`() {
        val existing = listOf(DeviceProfile("11111", 1L), DeviceProfile("22222", 2L))

        /* Re-pairing an existing port promotes it to the front */
        val promoted = DeviceProfile.withNewProfile(existing, "22222")
        assertEquals(listOf("22222", "11111"), promoted.map { it.port })

        /* The list never exceeds the cap */
        val many = (1..7).map { DeviceProfile(it.toString(), it.toLong()) }
        assertEquals(5, DeviceProfile.withNewProfile(many, "99999").size)
        assertEquals("99999", DeviceProfile.withNewProfile(many, "99999").first().port)
    }
}
