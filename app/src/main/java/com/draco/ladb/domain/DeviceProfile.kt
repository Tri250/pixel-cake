package com.draco.ladb.domain

/**
 * A remembered wireless-debugging pairing target, used to prefill the
 * pairing dialog and speed up re-pairing.
 */
data class DeviceProfile(
    val port: String,
    val pairedAt: Long
) {
    companion object {
        private const val KEY_PORT = "port"
        private const val KEY_PAIRED_AT = "paired_at"
        private const val MAX_PROFILES = 5

        fun encodeAll(profiles: List<DeviceProfile>): String =
            JsonCodec.encodeMapList(profiles.map { profile ->
                mapOf(KEY_PORT to profile.port, KEY_PAIRED_AT to profile.pairedAt.toString())
            })

        fun decodeAll(json: String): List<DeviceProfile> =
            JsonCodec.decodeMapList(json).mapNotNull { map ->
                val port = map[KEY_PORT] ?: return@mapNotNull null
                DeviceProfile(port, map[KEY_PAIRED_AT]?.toLongOrNull() ?: 0L)
            }

        /**
         * Returns the list with [port] moved to the front (newest first),
         * deduplicated and capped at [MAX_PROFILES] entries.
         */
        fun withNewProfile(existing: List<DeviceProfile>, port: String): List<DeviceProfile> =
            (listOf(DeviceProfile(port, System.currentTimeMillis())) +
                    existing.filterNot { it.port == port }).take(MAX_PROFILES)
    }
}
