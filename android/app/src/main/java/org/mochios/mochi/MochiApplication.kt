package org.mochios.mochi

import android.app.Application
import android.content.Context
import dagger.hilt.android.HiltAndroidApp
import org.mochios.android.i18n.AppContext
import org.mochios.android.i18n.LanguageStore
import org.mochios.android.i18n.LocaleHelper
import org.mochios.android.push.PushServiceWatchdog

@HiltAndroidApp
class MochiApplication : Application() {

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(LocaleHelper.wrap(base, LanguageStore.get(base)))
    }

    override fun onCreate() {
        super.onCreate()
        AppContext.set(this)
        LocaleHelper.apply(this, LanguageStore.get(this))
        PushServiceWatchdog.schedule(this)
    }
}
