package org.mochios.mochi.ui.launchpad

import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.mochios.mochi.R

private data class InstalledMochiApp(
    val packageName: String,
    val label: String,
)

private val MOCHI_PACKAGES = listOf(
    "org.mochios.feeds",
    "org.mochios.chat",
    "org.mochios.forums",
    "org.mochios.projects",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LaunchPadScreen() {
    val context = LocalContext.current
    var apps by remember { mutableStateOf(emptyList<InstalledMochiApp>()) }

    LaunchedEffect(Unit) {
        val pm = context.packageManager
        apps = MOCHI_PACKAGES.mapNotNull { pkg ->
            try {
                val info = pm.getApplicationInfo(pkg, 0)
                InstalledMochiApp(packageName = pkg, label = pm.getApplicationLabel(info).toString())
            } catch (_: PackageManager.NameNotFoundException) {
                null
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text(stringResource(R.string.app_name)) })
        },
    ) { padding ->
        if (apps.isEmpty()) {
            EmptyState(padding)
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(apps, key = { it.packageName }) { app ->
                    Button(
                        onClick = {
                            val launch = context.packageManager.getLaunchIntentForPackage(app.packageName)
                            if (launch != null) context.startActivity(launch)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(app.label)
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyState(padding: PaddingValues) {
    androidx.compose.foundation.layout.Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(32.dp),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.launchpad_no_apps),
            style = MaterialTheme.typography.bodyLarge,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}
