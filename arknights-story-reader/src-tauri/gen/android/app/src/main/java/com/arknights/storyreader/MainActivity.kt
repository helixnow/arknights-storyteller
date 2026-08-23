package com.arknights.storyreader

import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    compensateInsetsForOldWebViews()

    // Bridge the Android hardware back button into the web frontend.
    //
    // The default TauriActivity finishes the activity on back press, which
    // means the whole app exits even when there is an in-app navigation stack
    // (reader open, modal open, etc). We dispatch a `CustomEvent("app-back")`
    // into the WebView and let JS decide whether to consume it. If the JS
    // handler sets `evt.defaultPrevented`, we don't fall back to the Android
    // default behavior.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val currentWebView = webView
          if (currentWebView == null) {
            dispatchDefaultBack()
            return
          }
          val script =
            "(() => { const e = new CustomEvent('app-back', { cancelable: true }); " +
              "window.dispatchEvent(e); return e.defaultPrevented; })();"
          try {
            currentWebView.evaluateJavascript(script) { handled ->
              // `handled` is the serialized JS return value ("true" / "false" / null)
              val consumed = handled == "true"
              if (!consumed) {
                runOnUiThread { dispatchDefaultBack() }
              }
            }
          } catch (_: Exception) {
            // evaluateJavascript throws if the WebView was already destroyed;
            // never crash or swallow the back press in that case.
            dispatchDefaultBack()
          }
        }

        // Disable this callback and re-dispatch so the default exit logic
        // runs. Always re-enable afterwards: if the activity survives (e.g.
        // another callback consumed the event, or the WebView attaches
        // later), the bridge must keep working for the next back press.
        private fun dispatchDefaultBack() {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    )
  }

  /**
   * The manifest declares `uiMode` in `configChanges`, so a system light/dark
   * switch does not recreate the activity. [enableEdgeToEdge] chose the
   * status/navigation bar icon appearance from the uiMode current at
   * [onCreate]; the web content meanwhile follows `prefers-color-scheme` and
   * re-themes immediately, leaving e.g. dark clock/battery icons over a
   * now-dark page — invisible until the app is restarted. Re-applying the
   * edge-to-edge style here re-reads the current uiMode and keeps the system
   * bar icons readable.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
  }

  /**
   * The WebView engine only copes with an edge-to-edge window in recent
   * versions: system bars / display cutout are forwarded to the CSS
   * `safe-area-inset-*` values since M136, and the soft keyboard resizes the
   * visual viewport since M139. On older engines (common on devices without
   * Play auto-updates) the page top renders underneath the status bar, and
   * the keyboard covers the focused input because `adjustResize` is ignored
   * once the window draws edge-to-edge.
   *
   * Compensate natively only for what the engine cannot do itself, by
   * padding the content FrameLayout (WebView ignores its own padding). The
   * insets are returned unconsumed on purpose: newer engines read them to
   * compute the CSS safe area, and consuming them here would zero those
   * values out.
   */
  private fun compensateInsetsForOldWebViews() {
    // `version` comes from WryActivity and reports the WebView provider,
    // e.g. "139.0.7258.62". An empty/unparseable value only happens on very
    // old devices, which need the compensation anyway.
    val engineMajor = version.substringBefore('.').toIntOrNull() ?: 0
    if (engineMajor >= 139) return

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      if (engineMajor >= 136) {
        // Safe area already works (the WebView fills the window); only the
        // keyboard handling is missing.
        view.setPadding(0, 0, 0, ime.bottom)
      } else {
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      }
      insets
    }
  }

  /**
   * TauriActivity calls [onWebViewCreate] (or similar) when the WebView has
   * been attached. We keep a reference so we can talk to it from the back
   * handler. If the hook name changes in future Tauri versions, we fall back
   * to [findWebView] which walks the view tree.
   */
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onResume() {
    super.onResume()
    if (webView == null) {
      webView = findWebView(window.decorView.rootView)
    }
  }

  private fun findWebView(view: android.view.View): WebView? {
    if (view is WebView) return view
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }
}
