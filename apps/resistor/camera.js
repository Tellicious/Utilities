/* =========================================================
   Camera module — capture, detect, display
   ========================================================= */

const cam = {
  video: document.getElementById('camVideo'),
  shutter: document.getElementById('camShutter'),
  pickFile: document.getElementById('camPickFile'),
  flip: document.getElementById('camFlip'),
  fileInput: document.getElementById('camFileInput'),
  stage: document.getElementById('cameraStage'),
  loading: document.getElementById('camLoading'),
  loadingTxt: document.getElementById('camLoadingText'),
  result: document.getElementById('camResult'),
  resultTitle: document.getElementById('camResultTitle'),
  retake: document.getElementById('camRetake'),
  openPicker: document.getElementById('camOpenPicker'),
  photoCanvas: document.getElementById('camPhotoCanvas'),
  render: document.getElementById('camRender'),
  value: document.getElementById('camValue'),
  meta: document.getElementById('camMeta'),
  bands: document.getElementById('camBands'),
  hint: document.getElementById('camHint'),
  debug: document.getElementById('camDebug'),
  debugImg: document.getElementById('camDebugImg'),
  error: document.getElementById('camError'),
  errorText: document.getElementById('camErrorText'),
  pickFallback: document.getElementById('camPickFallback'),

  stream: null,
  facingMode: 'environment',
  lastDetection: null,
};

// ---------- Stream lifecycle ----------

async function startCamera() {
  // Stop any existing stream
  stopCamera();

  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: cam.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    });
    cam.video.srcObject = cam.stream;
    cam.error.hidden = true;
    cam.stage.style.display = '';
  } catch (err) {
    showError(err);
  }
}

function stopCamera() {
  if (cam.stream) {
    cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null;
  }
  cam.video.srcObject = null;
}

function showError(err) {
  cam.stage.style.display = 'none';
  cam.error.hidden = false;
  const msg = (err && err.name === 'NotAllowedError')
    ? "Camera permission was denied. Allow access in Settings or pick a photo instead."
    : (err && err.name === 'NotFoundError')
      ? "No camera available on this device."
      : "Camera couldn't start: " + (err && err.message ? err.message : 'unknown error');
  cam.errorText.textContent = msg;
}

// ---------- Capture ----------

function captureFromVideo() {
  if (!cam.video.videoWidth) return null;
  // Capture the entire video frame, then crop to the guide-box area —
  // a horizontal strip centred in the frame, matching the on-screen guide
  // (78% width, 5:2 aspect ratio). This focuses the CV pipeline on where
  // the user was told to place the resistor.
  const vw = cam.video.videoWidth;
  const vh = cam.video.videoHeight;

  // The video element uses object-fit: cover, so the visible area in the
  // viewfinder is a centered crop of the video. We replicate that crop
  // by taking the same centered region the user saw.
  // The viewfinder fills its container (camera__stage). The video frame
  // is cropped to that container's aspect ratio. Without knowing the
  // exact container size, we approximate by taking the full frame and
  // cropping a 78% × 5:2 box from its centre.
  const guideW = vw * 0.78;
  const guideH = guideW / 2.5;  // 5:2 ratio
  const guideX = (vw - guideW) / 2;
  const guideY = (vh - guideH) / 2;

  const c = document.createElement('canvas');
  c.width = Math.round(guideW);
  c.height = Math.round(guideH);
  c.getContext('2d').drawImage(
    cam.video,
    guideX, guideY, guideW, guideH,  // source (crop)
    0, 0, c.width, c.height            // dest (full canvas)
  );
  return c;
}

async function captureFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Pipeline ----------

async function process(sourceCanvas) {
  if (!sourceCanvas) return;

  cam.loading.hidden = false;
  cam.loadingTxt.textContent = 'Analysing…';

  // Tick the UI before heavy work
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 30));

  // Cap source to a reasonable size before reading ImageData
  const maxDim = 1200;
  let work = sourceCanvas;
  const m = Math.max(work.width, work.height);
  if (m > maxDim) {
    const scale = maxDim / m;
    const c = document.createElement('canvas');
    c.width = Math.round(work.width * scale);
    c.height = Math.round(work.height * scale);
    c.getContext('2d').drawImage(work, 0, 0, c.width, c.height);
    work = c;
  }

  const ctx = work.getContext('2d');
  const imgData = ctx.getImageData(0, 0, work.width, work.height);

  let result;
  try {
    result = await window.ResistorCV.detectResistor(imgData);
  } catch (e) {
    console.error('CV failed', e);
    result = { success: false, reason: 'Internal error: ' + e.message };
  }

  cam.loading.hidden = true;
  cam.lastDetection = result;
  showResult(work, result);
}

function showResult(sourceCanvas, result) {
  // Hide live stage + error, show result
  stopCamera();
  cam.stage.style.display = 'none';
  cam.error.hidden = true;
  cam.result.hidden = false;

  // Draw the photo on the result canvas
  const pc = cam.photoCanvas;
  const ctx = pc.getContext('2d');
  pc.width = sourceCanvas.width;
  pc.height = sourceCanvas.height;
  ctx.drawImage(sourceCanvas, 0, 0);

  // Show the debug image (what the CV pipeline analyzed) if available.
  // This is shown in both success and failure cases.
  cam.debugImg.innerHTML = '';
  if (result.debugImage) {
    cam.debug.hidden = false;
    // The debug image is a canvas; we display it scaled to fit.
    const dbg = result.debugImage;
    dbg.classList.add('camera__debug-canvas');
    cam.debugImg.appendChild(dbg);
  } else {
    cam.debug.hidden = true;
  }

  if (!result.success) {
    cam.resultTitle.textContent = "Couldn't read this";
    cam.value.textContent = '—';
    cam.meta.textContent = '';
    cam.bands.innerHTML = '';
    cam.render.innerHTML = '';
    cam.hint.textContent = (result.reason || 'Please retake the photo.')
      + ' You can also tap Edit to set the bands manually.';
    // Always offer Edit — even on failure — so user can pick bands manually.
    cam.openPicker.style.visibility = '';
    return;
  }

  cam.openPicker.style.visibility = '';
  cam.resultTitle.textContent = `${result.mode}-band resistor`;

  // Render detected resistor
  cam.render.innerHTML = window.ResistorEngine.renderResistorSVG(result.picks, result.mode);

  // Value + meta. If the CV pipeline could not establish that the final
  // band is gold/silver, it returns both left-to-right and right-to-left
  // candidates as requested.
  if (result.alternatives && result.alternatives.length === 2) {
    const [a, b] = result.alternatives;
    const fmt = (x) => (x && x.ohms != null && x.tol != null)
      ? `${window.ResistorEngine.formatOhms(x.ohms)} ± ${x.tol}%`
      : 'not decodable';
    cam.value.innerHTML = `A: ${fmt(a)}<br>B: ${fmt(b)}`;
    cam.meta.textContent = 'Ambiguous direction: last band is not gold/silver, so both readings are shown.';
  } else if (result.ohms != null && result.tol != null) {
    cam.value.textContent = `${window.ResistorEngine.formatOhms(result.ohms)}  ± ${result.tol}%`;
    const e = window.ResistorEngine.nearestStandard(result.ohms, result.tol);
    let meta = '';
    if (e && e.exact) meta = `${e.series} standard value ✓`;
    else if (e) meta = `Nearest ${e.series}: ${window.ResistorEngine.formatOhms(e.standard)}`;
    cam.meta.textContent = meta;
  } else {
    cam.value.textContent = '—';
    cam.meta.textContent = "Couldn't compute a value from these bands — tap Edit to adjust.";
  }

  // Bands with per-band confidence.
  // Confidence is 0..1; below 0.40 we mark as uncertain.
  const LOW_CONF = 0.40;
  cam.bands.innerHTML = '';
  result.bands.forEach((b) => {
    const c = window.ResistorEngine.COLOR_BY_ID[b.colorId];
    if (!c) return;
    const pill = document.createElement('span');
    const isLow = b.confidence < LOW_CONF;
    pill.className = 'camera__band' + (isLow ? ' camera__band--low' : '');
    const heightText = b.heightRatio ? ` ${Math.round(b.heightRatio * 100)}%h` : '';
    pill.innerHTML = `<span class="camera__band-dot" style="background:${c.hex}"></span>${c.name}${heightText}${isLow ? ' ?' : ''}`;
    cam.bands.appendChild(pill);
  });

  // Hint
  const anyLow = result.bands.some(b => b.confidence < LOW_CONF);
  const baseHint = result.reasoning || 'Tap Edit to fine-tune the result in the colour picker.';
  cam.hint.textContent = anyLow
    ? `${baseHint} Some bands looked uncertain (marked with ?).`
    : `${baseHint} Green box = detected resistor; red boxes = valid bands, each >=75% of box height.`;
}

// ---------- Event wiring ----------

cam.shutter.addEventListener('click', async () => {
  const c = captureFromVideo();
  if (c) {
    await process(c);
  } else {
    // Video isn't ready — show a helpful error rather than failing silently.
    console.warn('Camera shutter pressed but video has no frames yet', {
      readyState: cam.video.readyState,
      videoWidth: cam.video.videoWidth,
      stream: !!cam.stream,
    });
    // Brief visible flash so the user sees something happened
    cam.loading.hidden = false;
    cam.loadingTxt.textContent = 'Camera not ready yet — please wait a moment and try again.';
    setTimeout(() => { cam.loading.hidden = true; }, 1500);
  }
});

cam.pickFile.addEventListener('click', () => cam.fileInput.click());
cam.pickFallback.addEventListener('click', () => cam.fileInput.click());

cam.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-pick of same file
  if (!file) return;
  const c = await captureFromFile(file);
  await process(c);
});

cam.flip.addEventListener('click', async () => {
  cam.facingMode = cam.facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
});

cam.retake.addEventListener('click', async () => {
  cam.result.hidden = true;
  cam.stage.style.display = '';
  await startCamera();
});

cam.openPicker.addEventListener('click', () => {
  // On success: pre-fill picker with the detected bands
  // On failure: just switch to the picker with current/default bands
  if (cam.lastDetection && cam.lastDetection.success) {
    window.applyDetectedBands(cam.lastDetection.picks, cam.lastDetection.mode);
  } else {
    // Switch to picker view without changing the bands
    const pickerTab = document.querySelector('.tabbar__btn[data-view="picker"]');
    if (pickerTab) pickerTab.click();
  }
});

// Start/stop based on tab visibility
window.addEventListener('camera:enter', () => {
  if (!cam.result.hidden) return; // user still looking at result
  startCamera();
});
window.addEventListener('camera:leave', () => stopCamera());
window.addEventListener('beforeunload', stopCamera);
