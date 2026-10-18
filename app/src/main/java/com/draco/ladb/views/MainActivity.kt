package com.draco.ladb.views

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.*
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.lifecycleScope
import com.draco.ladb.BuildConfig
import com.draco.ladb.R
import com.draco.ladb.data.SettingsRepository
import com.draco.ladb.databinding.ActivityMainBinding
import com.draco.ladb.domain.CommandHistory
import com.draco.ladb.utils.ThemeUtil
import com.draco.ladb.viewmodels.MainActivityViewModel
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.system.exitProcess

class MainActivity : AppCompatActivity() {
    private val viewModel: MainActivityViewModel by viewModels()
    private lateinit var binding: ActivityMainBinding

    private lateinit var pairDialog: MaterialAlertDialogBuilder

    private var lastCommand = ""

    private val settings by lazy { SettingsRepository.getInstance(applicationContext) }
    private val history = CommandHistory()
    private var historyIndex = -1
    private var historyDraft = ""

    private var bookmarkGetResult = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val text = it.data?.getStringExtra(Intent.EXTRA_TEXT) ?: return@registerForActivityResult
        binding.command.setText(text)
    }

    private fun setupUI() {
        /* Fix stupid Google edge-to-edge bullshit */
        ViewCompat.setOnApplyWindowInsetsListener(binding.content) { v, windowInsets ->
            val systemBarsInsets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val statusBarInsets = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars())
            windowInsets.getInsets(WindowInsetsCompat.Type.statusBars())

            v.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                leftMargin = systemBarsInsets.left
                bottomMargin = systemBarsInsets.bottom
                rightMargin = systemBarsInsets.right
                topMargin = systemBarsInsets.top
            }
            binding.statusBarBackground.updateLayoutParams {
                height = statusBarInsets.top
            }

            WindowInsetsCompat.CONSUMED
        }
        supportActionBar!!.elevation = 0f
        WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars = false

        pairDialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.pair_title)
            .setCancelable(false)
            .setView(R.layout.dialog_pair)
            .setPositiveButton(R.string.pair, null)
            .setNegativeButton(R.string.help, null)
            .setNeutralButton(R.string.skip, null)

        binding.command.setOnKeyListener { _, keyCode, keyEvent ->
            if (keyEvent.action != KeyEvent.ACTION_DOWN)
                return@setOnKeyListener false

            when (keyCode) {
                KeyEvent.KEYCODE_ENTER -> {
                    sendCommandToADB()
                    true
                }
                KeyEvent.KEYCODE_DPAD_UP -> {
                    browseHistory(-1)
                    true
                }
                KeyEvent.KEYCODE_DPAD_DOWN -> {
                    browseHistory(1)
                    true
                }
                else -> false
            }
        }

        binding.command.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendCommandToADB()
                return@setOnEditorActionListener true
            } else {
                return@setOnEditorActionListener false
            }
        }
    }

    private fun sendCommandToADB() {
        val text = binding.command.text.toString()
        lastCommand = text

        if (text.isNotBlank()) {
            history.record(text)
            lifecycleScope.launch(Dispatchers.IO) {
                settings.setHistory(history.serialize())
            }
        }

        historyIndex = -1
        historyDraft = ""
        binding.command.text = null
        lifecycleScope.launch(Dispatchers.IO) {
            viewModel.adb.sendToShellProcess(text)
        }
    }

    /**
     * Recall older (step = -1) or newer (step = 1) commands with the
     * arrow keys. The in-progress draft is preserved while browsing.
     */
    private fun browseHistory(step: Int): Boolean {
        if (history.isEmpty())
            return false

        val entries = history.all()
        if (historyIndex == -1) {
            historyIndex = entries.size
            historyDraft = binding.command.text.toString()
        }

        historyIndex = (historyIndex + step).coerceIn(0, entries.size)
        val text = if (historyIndex == entries.size) historyDraft else entries[historyIndex]
        binding.command.setText(text)
        binding.command.setSelection(text.length)
        return true
    }

    private fun setReadyForInput(ready: Boolean) {
        binding.command.isEnabled = ready
        binding.commandContainer.hint =
            if (ready) getString(R.string.command_hint) else getString(R.string.command_hint_waiting)
        binding.progress.visibility = if (ready) View.INVISIBLE else View.VISIBLE
    }

    private fun setupDataListeners() {
        /* Update the output text */
        viewModel.outputText.observe(this) { newText ->
            binding.output.text = newText
            binding.outputScrollview.post {
                binding.outputScrollview.fullScroll(ScrollView.FOCUS_DOWN)
                binding.command.requestFocus()
                val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(binding.command, InputMethodManager.SHOW_FORCED)
            }
        }

        /* Restart the activity on reset */
        viewModel.adb.closed.observe(this) { closed ->
            if (closed == true) {
                val intent = Intent(this, MainActivity::class.java)
                startActivity(intent)
                finishAffinity()
                exitProcess(0)
            }
        }

        /* Prepare progress bar, pairing latch, and script executing */
        viewModel.adb.running.observe(this) { started ->
            setReadyForInput(started == true)
        }
    }

    private fun pairAndStart() {
        if (viewModel.needsToPair()) {
            viewModel.adb.debug("Requesting pairing information")
            requestPairing()
        } else {
            viewModel.startADBServer()
        }
    }

    private fun requestPairing() {
        askToPair { success ->
            if (success) {
                viewModel.setPairedBefore(true)
                viewModel.startADBServer()
            } else {
                /* Failed; let the user retry with an inline error hint */
                viewModel.adb.debug("Failed to pair! Trying again...")
                runOnUiThread { requestPairing() }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        ThemeUtil.apply(this)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (settings.blockingKeepScreenOn())
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        binding.output.textSize = settings.blockingFontSize().toFloatOrNull() ?: 14f

        setupUI()
        setupDataListeners()

        history.load(settings.blockingHistory())

        /* Ensure we are not running this a second time around */
        if (viewModel.viewModelHasStartedADB.value != true) {
            if (viewModel.isPairing.value != true)
                pairAndStart()
        }

        viewModel.piracyCheck()
    }

    /**
     * Ask the user to pair
     */
    private fun askToPair(failedBefore: Boolean = false, callback: ((Boolean) -> Unit)? = null) {
        pairDialog
            .create()
            .apply {
                setOnShowListener {
                    val portInput = findViewById<TextInputEditText>(R.id.port)!!
                    val codeInput = findViewById<TextInputEditText>(R.id.code)!!
                    val errorText = findViewById<TextView>(R.id.pair_error)!!

                    /* Prefill the last successfully paired port */
                    val latestPort = settings.blockingLatestPairedPort()
                    if (!latestPort.isNullOrEmpty() && portInput.text.isNullOrBlank())
                        portInput.setText(latestPort)

                    if (failedBefore) {
                        errorText.setText(R.string.pair_error_failed)
                        errorText.visibility = View.VISIBLE
                    }

                    getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val port = portInput.text.toString()
                        val code = codeInput.text.toString()

                        if (port.isBlank() || code.isBlank()) {
                            errorText.setText(R.string.pair_error_invalid)
                            errorText.visibility = View.VISIBLE
                            return@setOnClickListener
                        }

                        dismiss()

                        lifecycleScope.launch(Dispatchers.IO) {
                            viewModel.adb.debug("Trying to pair...")
                            val success = viewModel.adb.pair(port, code)
                            if (success)
                                viewModel.saveDeviceProfile(port)
                            callback?.invoke(success)
                        }
                    }

                    getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(getString(R.string.tutorial_url)))
                        try {
                            startActivity(intent)
                        } catch (e: Exception) {
                            e.printStackTrace()
                            Snackbar.make(
                                binding.output,
                                getString(R.string.snackbar_intent_failed),
                                Snackbar.LENGTH_SHORT
                            )
                                .show()
                        }
                    }

                    getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                        settings.putRawBoolean(SettingsRepository.KEY_AUTO_SHELL, false)
                        dismiss()
                        callback?.invoke(true)
                    }
                }
            }
            .show()
    }

    /**
     * Show the persisted command history in a picker dialog
     */
    private fun showHistoryDialog() {
        val entries = history.all().reversed()
        if (entries.isEmpty()) {
            Snackbar.make(binding.output, getString(R.string.history), Snackbar.LENGTH_SHORT).show()
            return
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.history)
            .setItems(entries.toTypedArray()) { _, which ->
                val command = entries[which]
                binding.command.setText(command)
                binding.command.setSelection(command.length)
            }
            .setNeutralButton(R.string.clear_history) { _, _ ->
                history.clear()
                lifecycleScope.launch(Dispatchers.IO) {
                    settings.setHistory(null)
                }
            }
            .setNegativeButton(R.string.dismiss, null)
            .show()
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.bookmarks -> {
                val intent = Intent(this, BookmarksActivity::class.java)
                    .putExtra(Intent.EXTRA_TEXT, binding.command.text.toString())
                bookmarkGetResult.launch(intent)
                true
            }

            R.id.last_command -> {
                binding.command.setText(lastCommand)
                binding.command.setSelection(lastCommand.length)
                true
            }

            R.id.history -> {
                showHistoryDialog()
                true
            }

            R.id.more -> {
                val intent = Intent(this, HelpActivity::class.java)
                startActivity(intent)
                true
            }

            R.id.share -> {
                try {
                    val uri = FileProvider.getUriForFile(
                        this,
                        BuildConfig.APPLICATION_ID + ".provider",
                        viewModel.adb.outputBufferFile
                    )
                    val intent = Intent(Intent.ACTION_SEND)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .setType("file/*")
                    startActivity(intent)
                } catch (e: Exception) {
                    e.printStackTrace()
                    Snackbar.make(binding.output, getString(R.string.snackbar_intent_failed), Snackbar.LENGTH_SHORT)
                        .setAction(getString(R.string.dismiss)) {}
                        .show()
                }
                true
            }

            R.id.clear -> {
                viewModel.clearOutputText()
                true
            }

            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }
}