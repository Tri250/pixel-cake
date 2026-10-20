package com.draco.ladb.viewmodels

import android.app.Application
import android.content.Context
import android.widget.EditText
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.draco.ladb.R
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.recyclers.BookmarksRecyclerAdapter
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class BookmarksActivityViewModel(application: Application) : AndroidViewModel(application) {
    private val settings = SettingsRepository.getInstance(application.applicationContext)

    val recyclerAdapter = BookmarksRecyclerAdapter { persist(it) }

    /**
     * Prepare the recycler view. The stored bookmarks are loaded off the main
     * thread so a cold start never stalls the UI on DataStore I/O.
     */
    fun prepareRecycler(context: Context, recycler: RecyclerView) {
        recycler.apply {
            adapter = recyclerAdapter
            layoutManager = LinearLayoutManager(context)
        }

        viewModelScope.launch(Dispatchers.IO) {
            val stored = settings.blockingBookmarks()
            withContext(Dispatchers.Main) {
                recyclerAdapter.updateList(stored)
            }
        }
    }

    /**
     * Persist bookmarks without touching the main thread.
     */
    private fun persist(values: Set<String>) {
        viewModelScope.launch(Dispatchers.IO) {
            settings.setBookmarks(values)
        }
    }

    fun add(context: Context, initialText: String) {
        val editText = EditText(context)
            .also {
                it.setText(initialText)
            }
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.add)
            .setView(editText)
            .setPositiveButton(R.string.done) { _, _ ->
                val text = editText.text.toString()
                if (text.isNotEmpty())
                    recyclerAdapter.add(text)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    fun edit(context: Context, text: String) {
        val editText = EditText(context)
            .also { it.setText(text) }
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.edit)
            .setView(editText)
            .setPositiveButton(R.string.done) { _, _ ->
                val newText = editText.text.toString()
                if (newText.isNotEmpty() && newText != text)
                    recyclerAdapter.edit(text, newText)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    fun areYouSure(context: Context, callback: () -> Unit) {
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.delete)
            .setMessage(R.string.delete_confirm)
            .setPositiveButton(R.string.delete) { _, _ -> callback() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * Confirm an import, which overwrites the whole list.
     */
    fun areYouSureImport(context: Context, count: Int, callback: () -> Unit) {
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.import_bookmarks)
            .setMessage(context.getString(R.string.import_confirm, count))
            .setPositiveButton(R.string.import_bookmarks) { _, _ -> callback() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * Replace all bookmarks with the imported entries
     */
    fun importBookmarks(entries: List<String>) {
        recyclerAdapter.replaceAll(entries)
    }
}
