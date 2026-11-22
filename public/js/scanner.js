// Camera barcode scanning. Uses the native BarcodeDetector (Android, ChromeOS,
// some desktop Chrome/Edge) and falls back to ZXing (iPhone/iPad Safari, Windows, etc).
// Handheld USB/Bluetooth scanners need none of this: they type into the focused
// field and press Enter.

let zxingLoading = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoading) {
    zxingLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = () => { zxingLoading = null; reject(new Error('Could not load the barcode library')); };
      document.head.appendChild(s);
    });
  }
  return zxingLoading;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats?.length) return null;
    return new window.BarcodeDetector({ formats });
  } catch { return null; }
}

export function cameraSupported() {
  return !!(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

/** Opens a full-screen scanner. Resolves with the decoded text, or null if cancelled. */
export function scanBarcode({ title = 'Scan barcode' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'scanner';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
      <div class="scanner-top"><span>${title}</span><button type="button" class="btn ghost light" data-close>Cancel</button></div>
      <div class="scanner-stage"><video playsinline muted autoplay></video><div class="scanner-frame"></div></div>
      <p class="scanner-msg">Point the camera at the sample barcode</p>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector('video');
    const msg = overlay.querySelector('.scanner-msg');
    let stream = null, raf = 0, zxReader = null, finished = false;

    const finish = (value) => {
      if (finished) return; finished = true;
      cancelAnimationFrame(raf);
      try { zxReader?.reset(); } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (value && navigator.vibrate) navigator.vibrate(60);
      resolve(value ? String(value).trim() : null);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-close]').onclick = () => finish(null);

    if (!cameraSupported()) {
      msg.textContent = 'Camera scanning needs HTTPS and a camera. Use a handheld scanner or type the number.';
      return;
    }

    (async () => {
      const detector = await nativeDetector();
      const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      try {
        if (detector) {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (finished) return finish(null);
          video.srcObject = stream;
          await video.play().catch(() => {});
          let last = 0;
          const tick = async (t) => {
            if (finished) return;
            if (t - last > 120 && video.readyState >= 2) {
              last = t;
              try {
                const codes = await detector.detect(video);
                if (codes.length) return finish(codes[0].rawValue);
              } catch { /* keep trying */ }
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        } else {
          const ZXing = await loadZXing();
          if (finished) return;
          zxReader = new ZXing.BrowserMultiFormatReader();
          await zxReader.decodeFromConstraints(constraints, video, (result) => { if (result) finish(result.getText()); });
        }
      } catch (e) {
        msg.textContent = e?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in your browser settings, or type the number.'
          : `Camera unavailable: ${e?.message || e}`;
      }
    })();
  });
}
