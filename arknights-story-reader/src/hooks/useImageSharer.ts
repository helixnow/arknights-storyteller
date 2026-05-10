import { invoke } from "@tauri-apps/api/core";
import { detectRuntimePlatform } from "@/hooks/useAppUpdater";

export interface SaveImageResponse {
  saved: boolean;
  uri?: string | null;
  needsPermission: boolean;
}

export interface ShareImageResponse {
  shared: boolean;
}

export interface ShareImagePayload {
  /** `data:image/png;base64,...` or raw base64 (the native side strips the prefix). */
  dataUrl: string;
  /** Preferred filename (extension is forced to `.png`). */
  fileName?: string;
  /** Optional title surfaced on the Android share chooser. */
  title?: string;
}

function assertAndroid() {
  if (detectRuntimePlatform() !== "android") {
    throw new Error("当前平台不支持原生分享/保存");
  }
}

/**
 * Save a PNG (encoded as base64 / data URL) into the device's shared
 * Pictures collection via the native Android plugin. Returns the MediaStore
 * URI on success; if the OS still requires the legacy
 * `WRITE_EXTERNAL_STORAGE` permission (Android 9 and below) the response's
 * `needsPermission` flag is set to true and the caller should surface a
 * manual-grant prompt.
 */
export async function saveImageToGallery(
  payload: ShareImagePayload
): Promise<SaveImageResponse> {
  assertAndroid();
  return invoke<SaveImageResponse>("plugin:image-sharer|save_image", {
    base64: payload.dataUrl,
    fileName: payload.fileName ?? null,
  });
}

/**
 * Launch the Android share sheet with the provided PNG. The image is
 * written to the app cache and exposed through the existing FileProvider
 * so no runtime permission is required.
 */
export async function shareImageViaSystem(
  payload: ShareImagePayload
): Promise<ShareImageResponse> {
  assertAndroid();
  return invoke<ShareImageResponse>("plugin:image-sharer|share_image", {
    base64: payload.dataUrl,
    fileName: payload.fileName ?? null,
    title: payload.title ?? null,
  });
}

/**
 * Open the app details page so the user can grant the legacy
 * `WRITE_EXTERNAL_STORAGE` permission manually. Only relevant on Android
 * 9 and below; safe to call on newer versions (no-op in that case).
 */
export async function openStoragePermissionSettings(): Promise<void> {
  assertAndroid();
  await invoke("plugin:image-sharer|open_storage_permission_settings");
}

/**
 * Desktop / browser fallback for saving the PNG. Converts the data URL to
 * a Blob and triggers a download via an anchor element — this works
 * reliably inside Tauri's WKWebView / WebView2 (which occasionally choke
 * on very long `data:` URLs) and falls back gracefully outside Tauri.
 *
 * Pass `blob` directly when the caller already holds one to skip the
 * data-URL → bytes round-trip (canvas `toBlob()` is ~20% faster than
 * `toDataURL()` + atob on large images and here we already did both).
 */
export function saveImageToDesktopFile(
  payload: ShareImagePayload & { blob?: Blob | null }
): boolean {
  const blob =
    payload.blob ?? new Blob([new Uint8Array(decodeDataUrl(payload.dataUrl))], { type: "image/png" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download =
      payload.fileName && payload.fileName.endsWith(".png")
        ? payload.fileName
        : `${payload.fileName ?? "story"}.png`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    // Release the URL on the next tick so the WebView has time to initiate
    // the download before the Blob is revoked.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
  return true;
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * @deprecated Use {@link saveImageToDesktopFile} — it uses a Blob URL which
 * is more reliable in Tauri WebViews than raw `data:` URLs.
 */
export function downloadImageInBrowser(payload: ShareImagePayload): void {
  saveImageToDesktopFile(payload);
}
