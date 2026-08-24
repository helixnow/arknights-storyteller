package com.arknights.storyreader.imagesharer

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import androidx.core.content.ContextCompat
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@InvokeArg
class SaveImageArgs {
  lateinit var base64: String
  var fileName: String? = null
}

@InvokeArg
class ShareImageArgs {
  lateinit var base64: String
  var fileName: String? = null
  var title: String? = null
}

/**
 * Bridges the Tauri frontend with Android's image-sharing APIs.
 *
 * Two commands are exposed:
 *
 * - `saveImage`: drops a PNG into the shared Pictures collection via
 *   `MediaStore` (on API 29+ this needs no runtime permission; on API 28
 *   and below we require `WRITE_EXTERNAL_STORAGE` and surface a
 *   `needsPermission=true` response so the JS layer can prompt the user).
 *
 * - `shareImage`: stashes the PNG in the app cache, exposes it via the
 *   project's existing FileProvider, and fires `ACTION_SEND` with an
 *   `image/png` mime so the user can forward it through any installed app.
 */
@TauriPlugin
class ImageSharerPlugin(private val activity: Activity) : Plugin(activity) {
  // Tauri 的插件命令经 wry MainPipe 派发，@Command 方法一律在 Android 主
  // 线程执行。长截图的 base64 载荷可达几十 MB，JSON 解析、Base64 解码和
  // 落盘都必须移到 IO 线程，否则每次保存/分享都会冻结 UI 数百毫秒到数秒，
  // 低端机上足以触发 ANR。模式与 ApkUpdaterPlugin 的下载协程一致。
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  /**
   * Open the system app-details settings page so the user can grant the
   * legacy `WRITE_EXTERNAL_STORAGE` permission manually. Only meaningful on
   * Android 9 and below — API 29+ uses Scoped Storage and doesn't need the
   * runtime permission at all.
   *
   * We deliberately skip `Activity.requestPermissions()` here because the
   * Tauri plugin base class doesn't consistently forward
   * `onRequestPermissionsResult` back to plugins across Tauri 2.x minor
   * versions; punting to the settings page is boring but reliable.
   */
  @Command
  fun openStoragePermissionSettings(invoke: Invoke) {
    val intent = Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.parse("package:${activity.packageName}")
    ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "打开系统设置失败")
    }
  }

  @Command
  fun saveImage(invoke: Invoke) {
    scope.launch {
      // parseArgs 也要留在协程里：它对包含整段 base64 的 JSON 做 Jackson
      // 反序列化，载荷大时这一步本身就是主线程卡顿的大头。
      try {
        val args = invoke.parseArgs(SaveImageArgs::class.java)
        val bytes = try {
          decodeBase64(args.base64)
        } catch (ex: IllegalArgumentException) {
          runOnMain { invoke.reject("图片数据无效: ${ex.message}") }
          return@launch
        }

        val displayName = sanitizeFileName(args.fileName) ?: defaultFileName()

        // Android 9 and below still require the legacy storage permission to
        // write into shared collections. Surface a needsPermission=true response
        // so the web layer can decide whether to show a rationale dialog.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
          ContextCompat.checkSelfPermission(
            activity, Manifest.permission.WRITE_EXTERNAL_STORAGE
          ) != PackageManager.PERMISSION_GRANTED
        ) {
          val response = JSObject()
          response.put("saved", false)
          response.put("needsPermission", true)
          runOnMain { invoke.resolve(response) }
          return@launch
        }

        val uri = writeImageToGallery(displayName, bytes)
        val response = JSObject()
        response.put("saved", true)
        response.put("uri", uri.toString())
        response.put("needsPermission", false)
        runOnMain { invoke.resolve(response) }
      } catch (cancelled: CancellationException) {
        // Plugin destroyed mid-save; nobody is listening for the result.
        throw cancelled
      } catch (ex: Exception) {
        runOnMain { invoke.reject(ex.message ?: "保存失败") }
      }
    }
  }

  @Command
  fun shareImage(invoke: Invoke) {
    scope.launch {
      try {
        val args = invoke.parseArgs(ShareImageArgs::class.java)
        val bytes = try {
          decodeBase64(args.base64)
        } catch (ex: IllegalArgumentException) {
          runOnMain { invoke.reject("图片数据无效: ${ex.message}") }
          return@launch
        }

        val displayName = sanitizeFileName(args.fileName) ?: defaultFileName()
        val cacheFile = writeToShareCache(displayName, bytes)
        val uri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          cacheFile
        )

        val sendIntent = Intent(Intent.ACTION_SEND).apply {
          type = "image/png"
          putExtra(Intent.EXTRA_STREAM, uri)
          // Some targets (notably mainstream Chinese IM apps) read the URI
          // permission grant off the clip data instead of the EXTRA_STREAM
          // flags. Attaching both keeps the broadest compatibility.
          clipData = android.content.ClipData.newUri(activity.contentResolver, "image", uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        val chooser = Intent.createChooser(sendIntent, args.title ?: "分享图片").apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runOnMain {
          // 这里已经离开协程的 try/catch：startActivity 抛异常（个别精简
          // ROM 上没有 chooser 组件）时必须就地兜住，主线程未捕获异常会
          // 直接闪退——与 ApkUpdater 安装 intent 的教训相同。
          try {
            activity.startActivity(chooser)
            val response = JSObject()
            response.put("shared", true)
            invoke.resolve(response)
          } catch (ex: Exception) {
            invoke.reject(ex.message ?: "分享失败")
          }
        }
      } catch (cancelled: CancellationException) {
        // Plugin destroyed mid-share; nobody is listening for the result.
        throw cancelled
      } catch (ex: Exception) {
        runOnMain { invoke.reject(ex.message ?: "分享失败") }
      }
    }
  }

  private fun decodeBase64(raw: String): ByteArray {
    val payload = raw.substringAfter(',', raw).trim()
    if (payload.isEmpty()) {
      throw IllegalArgumentException("空数据")
    }
    return Base64.decode(payload, Base64.DEFAULT)
  }

  private fun defaultFileName(): String = "arknights-story-${System.currentTimeMillis()}.png"

  private fun sanitizeFileName(input: String?): String? {
    val trimmed = input?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    // Strip path separators / null bytes to keep MediaStore happy and rule
    // out traversal; cap the length so the filesystem never rejects the name.
    // 注意上限按字节算：Linux 文件名最长 255 字节，中文每字 3 字节，Rust
    // 侧截到 80 字符（可达 244 字节）后再叠加分享缓存的时间戳前缀（14 字
    // 节）就会超限。76 个 UTF-16 单元 ≤228 字节，加 .png 与前缀 ≤246 字节。
    // take 按 UTF-16 单元数刀：Rust 侧按码点截断，扩展平面字符占两个单元，
    // 截口落在代理对中间会留下半个非法字符——补一刀去掉孤立的高位代理
    // （孤立低位代理不可能出现：上游是 Rust 的合法 UTF-8 字符串）。
    val cleaned = trimmed.replace(Regex("[\\\\/:*?\"<>|\\u0000]+"), "_").take(76)
      .let { if (it.isNotEmpty() && it.last().isHighSurrogate()) it.dropLast(1) else it }
    if (cleaned.all { it == '.' }) return null
    return if (cleaned.endsWith(".png", ignoreCase = true)) cleaned else "$cleaned.png"
  }

  @Throws(IOException::class)
  private fun writeImageToGallery(displayName: String, bytes: ByteArray): Uri {
    val resolver = activity.contentResolver
    val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      @Suppress("DEPRECATION")
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    }

    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(
          MediaStore.Images.Media.RELATIVE_PATH,
          "${Environment.DIRECTORY_PICTURES}/ArknightsStoryReader"
        )
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
    }

    val uri = resolver.insert(collection, values)
      ?: throw IOException("无法创建媒体记录")

    try {
      resolver.openOutputStream(uri)?.use { out ->
        out.write(bytes)
        out.flush()
      } ?: throw IOException("无法写入媒体流")
    } catch (ex: Exception) {
      // Clean up the stub row if the write failed so we don't leave an
      // empty entry lingering in the gallery.
      try { resolver.delete(uri, null, null) } catch (_: Exception) {}
      throw ex
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
    }

    return uri
  }

  @Throws(IOException::class)
  private fun writeToShareCache(displayName: String, bytes: ByteArray): File {
    // Per `file_paths.xml`, the project's FileProvider exposes `cache-path`.
    // A dedicated `shared-images/` subfolder keeps these transient files
    // separate from the rest of the cache so they're easy to reason about.
    val dir = File(activity.cacheDir, "shared-images").apply { mkdirs() }
    // Opportunistic GC: purge any cache file older than an hour. Share
    // targets that asynchronously copy the URI have long finished by then;
    // anything still younger is potentially in flight from a previous
    // share so we leave it alone.
    val cutoff = System.currentTimeMillis() - 60 * 60 * 1000L
    try {
      dir.listFiles()?.forEach { file ->
        if (file.isFile && file.lastModified() < cutoff) {
          file.delete()
        }
      }
    } catch (_: Exception) {
      // Best-effort cleanup — a missing cache entry is never fatal.
    }
    // Uniquify the cache name so successive shares don't clobber each other
    // while a previous chooser is still holding the URI open.
    val unique = "${System.currentTimeMillis()}-$displayName"
    val out = File(dir, unique)
    // Defense-in-depth on top of sanitizeFileName: refuse to write anything
    // that would resolve outside the shared-images cache directory.
    if (!out.canonicalPath.startsWith(dir.canonicalPath + File.separator)) {
      throw IOException("非法文件名")
    }
    FileOutputStream(out).use { it.write(bytes) }
    return out
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
    scope.cancel()
  }
}
