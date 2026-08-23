package com.arknights.storyreader.updater

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

@InvokeArg
class DownloadArgs {
  lateinit var url: String
  var fileName: String? = null
}

@TauriPlugin
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  // Mirror the Rust-side reqwest client: 15s to connect, 60s per read/write
  // operation. No call timeout, since a large APK on a slow link can
  // legitimately take longer than any fixed total budget.
  private val httpClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .build()

  /** In-flight download, kept so onDestroy can abort the blocking read. */
  @Volatile
  private var activeCall: Call? = null

  @Command
  fun downloadAndInstall(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    // toHttpUrlOrNull only parses http/https URLs; the explicit scheme check
    // documents that anything else (file:, content:, javascript:, ...) is
    // rejected before we touch the network.
    val httpUrl = args.url.trim().toHttpUrlOrNull()
    if (httpUrl == null || (httpUrl.scheme != "http" && httpUrl.scheme != "https")) {
      invoke.reject("更新地址无效")
      return
    }

    scope.launch {
      try {
        val apkFile = downloadApk(httpUrl, args.fileName)

        if (!canRequestPackageInstalls()) {
          val result = JSObject()
          result.put("needsPermission", true)
          runOnMain { invoke.resolve(result) }
          return@launch
        }

        runOnMain {
          promptInstall(apkFile)
          val result = JSObject()
          result.put("status", "install-intent-launched")
          invoke.resolve(result)
        }
      } catch (cancelled: CancellationException) {
        // Plugin destroyed mid-download; nobody is listening for the result.
        throw cancelled
      } catch (error: Exception) {
        runOnMain { invoke.reject(sanitizeErrorMessage(error.message)) }
      }
    }
  }

  @Command
  fun openInstallPermissionSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${activity.packageName}")
      )
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
    }
    invoke.resolve()
  }

  /**
   * Streams the APK body to disk emitting periodic `apk-progress` events so
   * the web UI can render a download bar. Replaces the previous one-shot
   * `copyTo` which left the user staring at a spinner on large (>30MB) APKs.
   */
  private suspend fun downloadApk(url: HttpUrl, fileName: String?): File =
    withContext(Dispatchers.IO) {
      val name = sanitizeApkFileName(fileName)
        ?: "update-${System.currentTimeMillis()}.apk"
      val outputFile = File(activity.cacheDir, name)
      val call = httpClient.newCall(Request.Builder().url(url).build())
      activeCall = call
      try {
        call.execute().use { response ->
          if (!response.isSuccessful) {
            throw IOException("HTTP ${response.code}")
          }
          val body = response.body ?: throw IOException("响应体为空")
          val total = body.contentLength()
          emitProgress(0L, total, "开始下载")

          val buffer = ByteArray(32 * 1024)
          var downloaded = 0L
          var lastEmitBytes = 0L
          body.byteStream().use { input ->
            FileOutputStream(outputFile).use { output ->
              while (true) {
                ensureActive()
                val read = input.read(buffer)
                if (read <= 0) break
                output.write(buffer, 0, read)
                downloaded += read
                // Rate-limit events to avoid spamming the JS event bus.
                if (downloaded - lastEmitBytes >= 256 * 1024) {
                  lastEmitBytes = downloaded
                  emitProgress(downloaded, total, "下载中")
                }
              }
            }
          }
          emitProgress(downloaded, total, "下载完成")
          outputFile
        }
      } catch (error: Exception) {
        // Don't leave a truncated APK in the cache on failure/cancellation.
        outputFile.delete()
        throw error
      } finally {
        activeCall = null
      }
    }

  /**
   * The caller-supplied name is used verbatim as a file name inside
   * cacheDir, so strip path separators (and other characters MediaStore
   * dislikes) to rule out traversal, cap the length, and force an `.apk`
   * extension.
   */
  private fun sanitizeApkFileName(input: String?): String? {
    val trimmed = input?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val cleaned = trimmed.replace(Regex("[\\\\/:*?\"<>|\\u0000]+"), "_").take(128)
    if (cleaned.all { it == '.' }) return null
    return if (cleaned.endsWith(".apk", ignoreCase = true)) cleaned else "$cleaned.apk"
  }

  /**
   * OkHttp exception messages can embed the full request URL; scrub it so
   * the URL never reaches logcat or the JS layer via the rejection.
   */
  private fun sanitizeErrorMessage(raw: String?): String {
    val cleaned = raw?.replace(Regex("https?://\\S+"), "<url>")?.trim()
    return if (cleaned.isNullOrEmpty()) "下载更新失败" else cleaned
  }

  private fun emitProgress(current: Long, total: Long, message: String) {
    val payload = JSObject()
    payload.put("current", current)
    payload.put("total", total)
    payload.put("message", message)
    try {
      trigger("apk-progress", payload)
    } catch (ignored: Throwable) {
      // trigger() is best-effort; failures here should not abort the download.
    }
  }

  private fun canRequestPackageInstalls(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  private fun promptInstall(apkFile: File) {
    val uri = FileProvider.getUriForFile(
      activity,
      "${activity.packageName}.fileprovider",
      apkFile
    )
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(intent)
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      activity.runOnUiThread(block)
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    // Abort the blocking OkHttp read first (coroutine cancellation alone
    // can't interrupt it), then tear down the scope.
    activeCall?.cancel()
    activeCall = null
    scope.cancel()
  }
}
