package com.draco.ladb.views

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import com.draco.ladb.R
import com.draco.ladb.databinding.ActivityHelpBinding
import com.draco.ladb.fragments.HelpPreferenceFragment
import com.draco.ladb.utils.EdgeToEdgeUtil
import com.draco.ladb.utils.ThemeUtil

class HelpActivity : AppCompatActivity() {
    private lateinit var binding: ActivityHelpBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        ThemeUtil.apply(this)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityHelpBinding.inflate(layoutInflater)
        setContentView(binding.root)

        EdgeToEdgeUtil.applyInsets(binding.container, binding.statusBarBackground)
        supportActionBar?.elevation = 0f
        WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars = false

        supportFragmentManager
            .beginTransaction()
            .replace(R.id.container, HelpPreferenceFragment())
            .commit()
    }
}
