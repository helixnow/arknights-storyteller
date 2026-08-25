import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
    // CLI 2.8.x / tauri-build 2.6.x 可能不写 tauri.properties，回退成 1/1.0。
    // 缺字段时从 tauri.conf.json 按 major*1_000_000+minor*1000+patch 补上。
    if (getProperty("tauri.android.versionName").isNullOrBlank() ||
        getProperty("tauri.android.versionCode").isNullOrBlank()
    ) {
        val conf = file("../../tauri.conf.json")
        if (conf.exists()) {
            val match = Regex(""""version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"""").find(conf.readText())
            if (match != null) {
                val (major, minor, patch) = match.destructured
                if (getProperty("tauri.android.versionName").isNullOrBlank()) {
                    setProperty("tauri.android.versionName", "$major.$minor.$patch")
                }
                if (getProperty("tauri.android.versionCode").isNullOrBlank()) {
                    val code = major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt()
                    setProperty("tauri.android.versionCode", code.toString())
                }
            }
        }
    }
}

android {
    compileSdk = 36
    namespace = "com.arknights.storyreader"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.arknights.storyreader"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
