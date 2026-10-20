package com.draco.ladb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.Rule
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class NativeBinaryCheckTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `detects 4KB load alignment`() {
        val file = writeElf(alignments = listOf(4096, 4096))
        assertEquals(4096, NativeBinaryCheck.minLoadAlignment(file))
    }

    @Test
    fun `detects 16KB load alignment`() {
        val file = writeElf(alignments = listOf(16384, 16384))
        assertEquals(16384, NativeBinaryCheck.minLoadAlignment(file))
    }

    @Test
    fun `non ELF files are not reported as ELF problems`() {
        val file = tmp.newFile("garbage.so")
        file.writeBytes(ByteArray(128) { 0x41 })
        file.setExecutable(true)
        assertEquals(null, NativeBinaryCheck.minLoadAlignment(file))
        assertTrue(NativeBinaryCheck.validate(file, 16384) is NativeBinaryStatus.Ok)
    }

    @Test
    fun `missing binaries are reported as unusable`() {
        val status = NativeBinaryCheck.validate(File(tmp.root, "nope.so"), 16384)
        assertTrue(status is NativeBinaryStatus.Unusable)
    }

    @Test
    fun `4KB binaries are rejected on 16KB page devices`() {
        val file = writeElf(listOf(4096, 4096))
        val status = NativeBinaryCheck.validate(file, 16384)
        assertTrue(status is NativeBinaryStatus.PageSizeMismatch)

        val mismatch = status as NativeBinaryStatus.PageSizeMismatch
        assertEquals(4096, mismatch.alignment)
        assertEquals(16384, mismatch.pageSize)
    }

    @Test
    fun `16KB binaries pass on 16KB page devices`() {
        val file = writeElf(listOf(16384, 16384))
        assertTrue(NativeBinaryCheck.validate(file, 16384) is NativeBinaryStatus.Ok)
    }

    @Test
    fun `4KB binaries pass on 4KB page devices`() {
        val file = writeElf(listOf(4096, 4096))
        assertTrue(NativeBinaryCheck.validate(file, 4096) is NativeBinaryStatus.Ok)
    }

    /**
     * Build a minimal 64 bit ELF image with one PT_LOAD segment per
     * requested alignment.
     */
    private fun writeElf(alignments: List<Int>): File {
        val phoff = 64L
        val phentsize = 56
        val header = ByteBuffer.allocate(64).order(ByteOrder.LITTLE_ENDIAN)
        header.put(byteArrayOf(0x7f, 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte()))
        header.put(2.toByte())   // EI_CLASS = ELFCLASS64
        header.put(1.toByte())   // EI_DATA = ELFDATA2LSB
        header.put(1.toByte())   // EI_VERSION
        header.position(0x20)
        header.putLong(phoff)                      // e_phoff
        header.position(0x34)
        header.putShort(64.toShort())               // e_ehsize
        header.putShort(phentsize.toShort())        // e_phentsize
        header.putShort(alignments.size.toShort())  // e_phnum

        val phdrs = ByteBuffer.allocate(phentsize * alignments.size)
            .order(ByteOrder.LITTLE_ENDIAN)
        alignments.forEachIndexed { index, alignment ->
            phdrs.putInt(1)                     // p_type = PT_LOAD
            phdrs.putInt(5)                     // p_flags
            phdrs.putLong(0L)                   // p_offset
            phdrs.putLong((index * alignment).toLong()) // p_vaddr
            phdrs.putLong(0L)                   // p_paddr
            phdrs.putLong(alignment.toLong())   // p_filesz
            phdrs.putLong(alignment.toLong())   // p_memsz
            phdrs.putLong(alignment.toLong())   // p_align
        }

        val file = tmp.newFile("libadb.so")
        file.writeBytes(header.array() + phdrs.array())
        file.setExecutable(true)
        return file
    }
}
