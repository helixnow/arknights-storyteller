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

  /**
   * 并发下载守卫。前端有会话级 flag 与数据任务锁两道闸，但那都在 JS 层：
   * 万一两条 invoke 还是同时到达（未来新增的调用点、或 WebView 重载后
   * 旧 promise 仍在飞），两个协程会写同一个 cache 文件、互相截断出一个
   * 损坏的 APK，`activeCall` 也会被覆盖导致 onDestroy 只能中止其一。
   * 原生层作为最后防线直接拒绝后到的那条。
   */
  private val downloadInFlight = java.util.concurrent.atomic.AtomicBoolean(false)

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

    if (!downloadInFlight.compareAndSet(false, true)) {
      invoke.reject("已有更新下载正在进行，请等待完成后再试")
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
          // 这里已经离开协程的 try/catch：个别 ROM / TV 盒子上没有能处理
          // APK 安装 intent 的组件，startActivity 会抛 ActivityNotFoundException，
          // 主线程未捕获异常会直接闪退。必须就地兜住并转成可读的 reject。
          try {
            promptInstall(apkFile)
            val result = JSObject()
            result.put("status", "install-intent-launched")
            invoke.resolve(result)
          } catch (error: Exception) {
            val detail = error.message?.trim().orEmpty()
            invoke.reject(
              if (detail.isEmpty()) "无法启动系统安装界面"
              else "无法启动系统安装界面：$detail"
            )
          }
        }
      } catch (cancelled: CancellationException) {
        // Plugin destroyed mid-download; nobody is listening for the result.
        throw cancelled
      } catch (error: Exception) {
        runOnMain { invoke.reject(sanitizeErrorMessage(error.message)) }
      } finally {
        // CancellationException 走 rethrow 也会经过这里：守卫必须复位，
        // 否则一次被中止的下载会把后续所有更新请求永远锁在门外。
        downloadInFlight.set(false)
      }
    }
  }

  @Command
  fun openInstallPermissionSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // 部分 ROM / TV 盒子不认带 package: URI 的形式（抛
      // ActivityNotFoundException），退化到全局"安装未知应用"列表；
      // 两者都失败时给出可读错误，避免用户困在"需要权限"却无处授权。
      try {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${activity.packageName}")
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
      } catch (specific: Exception) {
        try {
          val fallback = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
          fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          activity.startActivity(fallback)
        } catch (generic: Exception) {
          invoke.reject("无法打开安装权限设置，请在系统设置中手动允许本应用安装未知应用")
          return
        }
      }
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
      purgeStaleApks(keep = name)
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
   * 装完（或放弃安装）的 APK 没有任何后续引用，却会一直躺在 cacheDir 里：
   * 回退命名带毫秒时间戳永不复用，manifest 命名通常也随版本变化，几个版本
   * 下来就是几百 MB 死文件。开新下载时顺手清掉旧的；只删超过 24 小时的，
   * 避免误删「系统安装界面还开着、用户马上要点安装」的那一份。
   */
  private fun purgeStaleApks(keep: String) {
    val cutoff = System.currentTimeMillis() - TimeUnit.HOURS.toMillis(24)
    activity.cacheDir.listFiles()?.forEach { file ->
      if (
        file.isFile &&
        file.name != keep &&
        file.name.endsWith(".apk", ignoreCase = true) &&
        file.lastModified() < cutoff
      ) {
        file.delete()
      }
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
    // Linux 文件名上限是 255 字节而非字符：Rust 侧对长度没有兜底，中文
    // 每字占 3 字节，按 80 个 UTF-16 单元截断（≤240 字节，加 .apk 后缀
    // 仍 ≤244 字节）才能保证落盘不因 ENAMETOOLONG 失败。
    val cleaned = trimmed.replace(Regex("[\\\\/:*?\"<>|\\u0000]+"), "_").take(80)
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
