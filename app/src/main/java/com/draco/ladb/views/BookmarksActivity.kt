package com.draco.ladb.views

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.recyclerview.widget.DefaultItemAnimator
import com.draco.ladb.R
import com.draco.ladb.databinding.ActivityBookmarksBinding
import com.draco.ladb.domain.JsonCodec
import com.draco.ladb.utils.EdgeToEdgeUtil
import com.draco.ladb.utils.ThemeUtil
import com.draco.ladb.viewmodels.BookmarksActivityViewModel
import com.google.android.material.snackbar.Snackbar
import java.nio.charset.StandardCharsets

class BookmarksActivity : AppCompatActivity() {
    private val viewModel: BookmarksActivityViewModel by viewModels()
    private lateinit var binding: ActivityBookmarksBinding
    private lateinit var initialText: String

    private val exportResult =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            if (uri != null)
                exportBookmarks(uri)
        }

    private val importResult =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null)
                importBookmarks(uri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        ThemeUtil.apply(this)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityBookmarksBinding.inflate(layoutInflater)
        setContentView(binding.root)

        EdgeToEdgeUtil.applyInsets(binding.content, binding.statusBarBackground)
        supportActionBar?.elevation = 0f
        WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars = false

        initialText = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""

        viewModel.prepareRecycler(this, binding.recycler)
        binding.recycler.itemAnimator = DefaultItemAnimator().apply {
            addDuration = 150
            removeDuration = 150
        }
        viewModel.recyclerAdapter.pickHook = {
            val intent = Intent()
                .putExtra(Intent.EXTRA_TEXT, it)
            setResult(RESULT_OK, intent)
            finish()
        }

        viewModel.recyclerAdapter.deleteHook = {
            viewModel.areYouSure(this) { viewModel.recyclerAdapter.delete(it) }
        }

        viewModel.recyclerAdapter.editHook = { viewModel.edit(this, it) }
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.add -> {
                viewModel.add(this, initialText)
                initialText = ""
                true
            }

            R.id.export_bookmarks -> {
                exportResult.launch("ladb_bookmarks.json")
                true
            }

            R.id.import_bookmarks -> {
                importResult.launch(arrayOf("application/json", "text/*", "application/octet-stream"))
                true
            }

            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun exportBookmarks(uri: Uri) {
        try {
            val payload = JsonCodec.encodeStringList(viewModel.recyclerAdapter.snapshot())
            contentResolver.openOutputStream(uri)?.use { stream ->
                stream.write(payload.toByteArray(StandardCharsets.UTF_8))
            } ?: throw IllegalArgumentException("Unable to open the destination file")

            Snackbar.make(binding.recycler, R.string.export_success, Snackbar.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.w(TAG, "Bookmark export failed", e)
            Snackbar.make(binding.recycler, R.string.export_failed, Snackbar.LENGTH_SHORT).show()
        }
    }

    private fun importBookmarks(uri: Uri) {
        val entries = try {
            val json = contentResolver.openInputStream(uri)
                ?.use { it.readBytes().decodeToString() }
                ?: ""

            JsonCodec.decodeStringList(json)
        } catch (e: Exception) {
            Log.w(TAG, "Bookmark import failed", e)
            Snackbar.make(binding.recycler, R.string.import_failed, Snackbar.LENGTH_SHORT).show()
            return
        }

        if (entries.isEmpty()) {
            Snackbar.make(binding.recycler, R.string.import_failed, Snackbar.LENGTH_SHORT).show()
            return
        }

        /* Import replaces everything, so confirm before losing the list. */
        viewModel.areYouSureImport(this, entries.size) { viewModel.importBookmarks(entries) }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.bookmarks, menu)
        return true
    }

    private companion object {
        const val TAG = "BookmarksActivity"
    }
}
