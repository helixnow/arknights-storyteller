package com.arknights.storyreader

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            return
          }
          val script =
            "(() => { const e = new CustomEvent('app-back', { cancelable: true }); " +
              "window.dispatchEvent(e); return e.defaultPrevented; })();"
          currentWebView.evaluateJavascript(script) { handled ->
            // `handled` is the serialized JS return value ("true" / "false" / null)
            val consumed = handled == "true"
            if (!consumed) {
              // Disable this callback and re-dispatch so the default exit logic runs.
              runOnUiThread {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
              }
            }
          }
        }
      }
    )
  }

  /**
   * TauriActivity calls [onWebViewCreate] (or similar) when the WebView has
   * been attached. We keep a reference so we can talk to it from the back
   * handler. If the hook name changes in future Tauri versions, we fall back
   * to [findWebView] which walks the view tree.
   */
  fun onWebViewCreate(webView: WebView) {
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
