package com.draco.ladb.domain

/**
 * Pure decision logic for choosing which connected ADB device to attach to
 * when multiple devices are present.
 *
 * Preference order:
 *  1. Local wireless device (serial contains "localhost")
 *  2. Any non-emulator device
 *  3. The first device as a last resort
 *
 * Returns null when there is nothing to choose from (0 or 1 devices),
 * in which case the adb default device should be used.
 */
object DeviceSelector {

    fun selectSerial(devices: List<String>): String? {
        if (devices.size <= 1)
            return null

        return devices.firstOrNull { it.contains("localhost") }
            ?: devices.firstOrNull { !it.contains("emulator") }
            ?: devices.first()
    }
}
