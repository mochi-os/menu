package org.mochios.mochi

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dagger.hilt.android.AndroidEntryPoint
import org.mochios.android.push.OemBackgroundHintDialog
import org.mochios.android.push.PushService
import org.mochios.android.push.RequestNotificationPermission
import org.mochios.android.ui.theme.MochiTheme
import org.mochios.mochi.ui.launchpad.LaunchPadScreen

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Start the distributor's background service so notifications survive
        // app close. PushService also restarts on boot via BootReceiver.
        PushService.start(this)
        setContent {
            MochiTheme(themeAnchors = null) {
                RequestNotificationPermission()
                OemBackgroundHintDialog()
                LaunchPadScreen()
            }
        }
    }
}
