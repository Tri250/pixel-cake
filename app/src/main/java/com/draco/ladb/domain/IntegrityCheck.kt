package com.draco.ladb.domain

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest

sealed class IntegrityResult {
    /** The integrity service responded with a well-formed token. */
    object Passed : IntegrityResult()

    /** The integrity service responded but returned no token. */
    object Failed : IntegrityResult()

    /** The integrity service is unavailable (no Play Store, offline, ...). */
    object Unknown : IntegrityResult()
}

/**
 * Replacement for the deprecated Play Licence (LVL) check, built on the
 * Play Integrity API.
 *
 * Verdict decryption normally requires a server side integration; without
 * one, a well-formed token response is treated as a pass and any failure is
 * treated as "unknown" (fail-open) so users are never locked out. A server
 * can later decrypt the token by hooking into [verify].
 */
class IntegrityCheck(context: Context) {
    private val appContext = context.applicationContext

    fun verify(callback: (IntegrityResult) -> Unit) {
        val integrityManager = IntegrityManagerFactory.create(appContext)
        val request = integrityManager.requestIntegrityToken(
            IntegrityTokenRequest.builder().build()
        )

        request.addOnSuccessListener { response ->
            callback(if (response.token().isNotEmpty()) IntegrityResult.Passed else IntegrityResult.Failed)
        }
        request.addOnFailureListener {
            callback(IntegrityResult.Unknown)
        }
    }
}
