package com.draco.ladb.domain

/**
 * Explicit lifecycle of the shell session, replacing scattered boolean
 * flags such as [tryingToPair] / [running] for observability.
 */
enum class ShellSessionState {
    /** No session has been started yet. */
    IDLE,

    /** A pairing attempt is in progress. */
    PAIRING,

    /** Waiting for the DNS-SD resolver to discover the ADB port. */
    DISCOVERING,

    /** Starting the ADB server and connecting to the local device. */
    CONNECTING,

    /** The shell is alive and accepting commands. */
    READY,

    /** The shell process died and will be reset. */
    DEAD
}
