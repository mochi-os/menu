plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "org.mochios.mochi"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.mochios.mochi"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            isPseudoLocalesEnabled = true
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

tasks.register("checkLocaleCompleteness") {
    val resDir = file("src/main/res")
    inputs.dir(resDir)
    doLast {
        val source = resDir.resolve("values/strings.xml")
        if (!source.exists()) return@doLast
        val keyPattern = Regex("""<string name="([^"]+)"""")
        val sourceKeys = keyPattern.findAll(source.readText()).map { it.groupValues[1] }.toSet()
        val overlays = setOf("values-en-rUS")
        val problems = mutableListOf<String>()
        resDir.listFiles { f -> f.isDirectory && f.name.startsWith("values-") }?.forEach { dir ->
            if (dir.name in overlays) return@forEach
            val xml = dir.resolve("strings.xml")
            if (!xml.exists()) return@forEach
            val have = keyPattern.findAll(xml.readText()).map { it.groupValues[1] }.toSet()
            val missing = sourceKeys - have
            if (missing.isNotEmpty()) {
                problems += "${dir.name}: ${missing.size} missing (${missing.take(3).joinToString()}…)"
            }
        }
        if (problems.isNotEmpty()) {
            logger.warn("Locale catalogs incomplete (run translate-android-from-web.py + fill residue):\n  " + problems.joinToString("\n  "))
        }
    }
}
tasks.named("preBuild") { dependsOn("checkLocaleCompleteness") }

dependencies {
    implementation(project(":lib"))

    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime)
    implementation(libs.activity.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.compose.ui.tooling.preview)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)

    implementation(libs.coroutines.core)
    implementation(libs.coroutines.android)
}
