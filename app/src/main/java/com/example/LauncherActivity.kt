package com.example

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.ui.screens.LiveHomeLauncherScreen
import com.example.ui.theme.AndroidLauncherTheme
import com.example.ui.viewmodel.LauncherViewModel
import com.example.ui.viewmodel.MainViewModel

class LauncherActivity : ComponentActivity() {

    private lateinit var launcherVm: LauncherViewModel
    private lateinit var mainVm: MainViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val appContainer = (application as AndroidLauncherApp).container
        mainVm = ViewModelProvider(this, MainViewModel.factory(appContainer))[MainViewModel::class.java]
        launcherVm = ViewModelProvider(this, LauncherViewModel.factory(appContainer))[LauncherViewModel::class.java]

        setContent {
            val activeTheme by mainVm.activeTheme.collectAsStateWithLifecycle()
            val activeWallpaper by mainVm.activeWallpaper.collectAsStateWithLifecycle()
            val settings by mainVm.settingsState.collectAsStateWithLifecycle()
            val remoteConfig by mainVm.remoteConfig.collectAsStateWithLifecycle()
            val liveWeather by mainVm.weatherSnapshot.collectAsStateWithLifecycle()
            val homeApps by launcherVm.homeApps.collectAsStateWithLifecycle()
            val allApps by launcherVm.allApps.collectAsStateWithLifecycle()
            val drawerApps by launcherVm.drawerApps.collectAsStateWithLifecycle()
            val searchQuery by launcherVm.searchQuery.collectAsStateWithLifecycle()
            val sortOrder by launcherVm.sortOrder.collectAsStateWithLifecycle()
            val statusBanner by launcherVm.statusBanner.collectAsStateWithLifecycle()
            val badgeCounts by launcherVm.notificationBadgeCounts.collectAsStateWithLifecycle()
            val allVisibleApps = remember(allApps) { allApps.filter { !it.isHidden } }

            // Pressing Back on a real Android HOME launcher stays on Home
            BackHandler(enabled = launcherVm.isDefaultLauncher.value) {
                // Keep user on Home screen cleanly when acting as default launcher
            }

            AndroidLauncherTheme(
                activeTheme = activeTheme,
                appearanceMode = settings.appearanceMode,
                reduceMotion = settings.reduceMotion,
                backgroundPreset = settings.backgroundPreset,
                liquidGlassEnabled = settings.liquidGlassEnabled,
                iconStyleOverride = settings.iconStyleOverride
            ) {
                LiveHomeLauncherScreen(
                    settings = settings,
                    homeApps = homeApps,
                    allVisibleApps = allVisibleApps,
                    drawerApps = drawerApps,
                    activeWallpaper = activeWallpaper,
                    wallpaperRenderer = appContainer.wallpaperRenderer,
                    searchQuery = searchQuery,
                    sortOrder = sortOrder,
                    statusBanner = statusBanner,
                    badgeCounts = badgeCounts,
                    notificationBadgesEnabled = remoteConfig.notificationBadgesEnabled,
                    edgePanelEnabled = remoteConfig.edgePanelEnabled,
                    controlCenterEnabled = remoteConfig.controlCenterEnabled,
                    liveWeather = liveWeather,
                    iconProvider = launcherVm::getAppIcon,
                    queryShortcuts = launcherVm::queryAppShortcuts,
                    onLaunchShortcut = launcherVm::launchShortcut,
                    onSearchQueryChange = launcherVm::updateSearchQuery,
                    onSortOrderChange = launcherVm::setSortOrder,
                    onLaunchApp = launcherVm::launchApp,
                    onToggleFavorite = launcherVm::toggleFavorite,
                    onToggleHidden = launcherVm::toggleHidden,
                    onPinToHome = { app -> launcherVm.pinToHome(app, pageIndex = 0, slotIndex = 0) },
                    onUnpinFromHome = launcherVm::unpinFromHome,
                    onOpenAppInfo = launcherVm::openAppInfo,
                    onUninstallApp = launcherVm::uninstallApp,
                    onToggleAutoRolling = { launcherVm.toggleAutoRolling(settings.autoRollingEnabled) },
                    onClearStatusBanner = launcherVm::clearStatusBanner,
                    onOpenUniversalSearch = {
                        if (!isFinishing && !isDestroyed) {
                            val searchIntent = Intent(this, MainActivity::class.java).apply {
                                putExtra(MainActivity.EXTRA_OPEN_SEARCH, true)
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            }
                            runCatching { startActivity(searchIntent) }
                        }
                    },
                    onOpenStudioSettings = {
                        if (!isFinishing && !isDestroyed) {
                            val studioIntent = Intent(this, MainActivity::class.java).apply {
                                putExtra(MainActivity.EXTRA_OPEN_LAUNCHER_HUB, true)
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            }
                            runCatching { startActivity(studioIntent) }
                        }
                    }
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::launcherVm.isInitialized) {
            launcherVm.refreshAppsAndDefaultStatus()
        }
    }
}
