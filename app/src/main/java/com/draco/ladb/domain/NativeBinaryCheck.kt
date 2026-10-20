package com.draco.ladb.domain

import java.io.File
import java.io.RandomAccessFile

/**
 * Result of validating a bundled native executable before it is spawned.
 */
sealed class NativeBinaryStatus {
    /** The binary can be executed on this device. */
    object Ok : NativeBinaryStatus()

    /** The file is missing, unreadable or not executable. */
    data class Unusable(val reason: String) : NativeBinaryStatus()

    /**
     * The ELF LOAD segments are aligned to [alignment] bytes, which is
     * smaller than the device page size [pageSize]. Such a binary cannot be
     * executed on 16 KB page kernels (Android 15+), which would otherwise
     * surface as an opaque launch failure.
     */
    data class PageSizeMismatch(val alignment: Int, val pageSize: Int) : NativeBinaryStatus()
}

/**
 * Pure Kotlin ELF reader used to keep the bundled ADB binary honest. It is
 * deliberately free of Android APIs so the logic is unit-testable.
 */
object NativeBinaryCheck {

    private const val ELF_MAGIC = 0x464c457fL /* "\u007fELF" little endian */
    private const val PT_LOAD = 1

    /**
     * Smallest alignment requested by the executable's LOAD segments, or
     * null when the file is not a readable ELF image.
     */
    fun minLoadAlignment(file: File): Int? {
        if (!file.exists() || !file.isFile)
            return null

        return try {
            RandomAccessFile(file, "r").use { raf ->
                if (raf.length() < 64)
                    return null

                val header = ByteArray(64)
                raf.seek(0)
                raf.readFully(header)

                /* ELF magic is byte order independent. */
                val magic = readInt(header, 0, true)
                if (magic.toLong() != ELF_MAGIC)
                    return null

                /* EI_CLASS: 1 = 32 bit, 2 = 64 bit */
                val is64 = header[4].toInt() == 2
                val little = header[5].toInt() == 1

                if (is64) {
                    val phoff = readLong(header, 0x20, little)
                    val phentsize = readShort(header, 0x36, little)
                    val phnum = readShort(header, 0x38, little)

                    if (phoff <= 0L || phentsize <= 0 || phnum <= 0 || phnum > 4096)
                        return null
                    if (phoff + phentsize.toLong() * phnum > raf.length())
                        return null

                    val phdrs = ByteArray(phentsize * phnum)
                    raf.seek(phoff)
                    raf.readFully(phdrs)

                    var min: Int? = null
                    for (i in 0 until phnum) {
                        val base = i * phentsize
                        val type = readInt(phdrs, base, little)
                        if (type != PT_LOAD)
                            continue
                        val align = readLong(phdrs, base + 0x30, little)
                        if (align > 0 && align <= Int.MAX_VALUE) {
                            val value = align.toInt()
                            min = if (min == null) value else kotlin.math.min(min, value)
                        }
                    }
                    min
                } else {
                    val phoff = readInt(header, 0x1c, little).toLong()
                    val phentsize = readShort(header, 0x2a, little)
                    val phnum = readShort(header, 0x2c, little)

                    if (phoff <= 0L || phentsize <= 0 || phnum <= 0 || phnum > 4096)
                        return null
                    if (phoff + phentsize.toLong() * phnum > raf.length())
                        return null

                    val phdrs = ByteArray(phentsize * phnum)
                    raf.seek(phoff)
                    raf.readFully(phdrs)

                    var min: Int? = null
                    for (i in 0 until phnum) {
                        val base = i * phentsize
                        val type = readInt(phdrs, base, little)
                        if (type != PT_LOAD)
                            continue
                        val align = readInt(phdrs, base + 0x1c, little)
                        if (align > 0) {
                            min = if (min == null) align else kotlin.math.min(min, align)
                        }
                    }
                    min
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Validate [file] against the running kernel's page size.
     */
    fun validate(file: File, pageSize: Int): NativeBinaryStatus {
        when {
            !file.exists() ->
                return NativeBinaryStatus.Unusable("missing at ${file.absolutePath}")
            !file.isFile ->
                return NativeBinaryStatus.Unusable("not a file: ${file.absolutePath}")
            !file.canExecute() ->
                return NativeBinaryStatus.Unusable("not executable: ${file.absolutePath}")
        }

        val alignment = minLoadAlignment(file) ?: return NativeBinaryStatus.Ok
        if (pageSize > 0 && alignment > 0 && pageSize > alignment)
            return NativeBinaryStatus.PageSizeMismatch(alignment, pageSize)

        return NativeBinaryStatus.Ok
    }

    private fun readInt(src: ByteArray, offset: Int, little: Boolean): Int {
        val b0 = src[offset].toInt() and 0xff
        val b1 = src[offset + 1].toInt() and 0xff
        val b2 = src[offset + 2].toInt() and 0xff
        val b3 = src[offset + 3].toInt() and 0xff
        return if (little) {
            (b3 shl 24) or (b2 shl 16) or (b1 shl 8) or b0
        } else {
            (b0 shl 24) or (b1 shl 16) or (b2 shl 8) or b3
        }
    }

    private fun readShort(src: ByteArray, offset: Int, little: Boolean): Int {
        val b0 = src[offset].toInt() and 0xff
        val b1 = src[offset + 1].toInt() and 0xff
        return if (little) (b1 shl 8) or b0 else (b0 shl 8) or b1
    }

    private fun readLong(src: ByteArray, offset: Int, little: Boolean): Long {
        var value = 0L
        for (i in 0 until 8) {
            val byte = src[offset + i].toLong() and 0xff
            val shift = if (little) i * 8 else (7 - i) * 8
            value = value or (byte shl shift)
        }
        return value
    }
}
