package com.draco.ladb.recyclers

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.draco.ladb.R

class BookmarksRecyclerAdapter(
    /** Called off the main thread path so persistence never blocks scrolling. */
    private val onPersist: (Set<String>) -> Unit
) : RecyclerView.Adapter<BookmarksRecyclerAdapter.ViewHolder>() {
    private val list = sortedSetOf<String>()

    var pickHook: (String) -> Unit = {}
    var deleteHook: (String) -> Unit = {}
    var editHook: (String) -> Unit = {}

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val content: TextView = view.findViewById(R.id.content)
        val delete: ImageButton = view.findViewById(R.id.delete)
        val edit: ImageButton = view.findViewById(R.id.edit)
    }

    @SuppressLint("NotifyDataSetChanged")
    fun updateList(values: Set<String>, refresh: Boolean = true) {
        list.clear()
        list.addAll(values)
        if (refresh)
            notifyDataSetChanged()
    }

    private fun saveList() {
        onPersist(list.toSet())
    }

    @SuppressLint("NotifyDataSetChanged")
    fun add(text: String) {
        list.add(text)
        notifyDataSetChanged()
        saveList()
    }

    @SuppressLint("NotifyDataSetChanged")
    fun delete(text: String) {
        list.remove(text)
        notifyDataSetChanged()
        saveList()
    }

    @SuppressLint("NotifyDataSetChanged")
    fun edit(text: String, newText: String) {
        list.remove(text)
        list.add(newText)
        notifyDataSetChanged()
        saveList()
    }

    /**
     * Replace every bookmark with [entries] (used by import)
     */
    @SuppressLint("NotifyDataSetChanged")
    fun replaceAll(entries: List<String>) {
        list.clear()
        list.addAll(entries)
        notifyDataSetChanged()
        saveList()
    }

    /**
     * Snapshot of the current bookmarks (used by export)
     */
    fun snapshot(): List<String> = list.toList()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        /* The list lives in memory and is refreshed by explicit mutations;
           re-reading DataStore here would block the main thread while
           scrolling. */
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.recycler_item, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val text = list.elementAt(position)
        holder.content.text = text
        holder.itemView.setOnClickListener { pickHook(text) }
        holder.delete.setOnClickListener { deleteHook(text) }
        holder.edit.setOnClickListener { editHook(text) }
    }

    override fun getItemCount() = list.size
}
