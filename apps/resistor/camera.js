/* =========================================================
   Camera module — capture, detect, display
   ========================================================= */

const cam = {
  video:      document.getElementById('camVideo'),
  shutter:    document.getElementById('camShutter'),
  pickFile:   document.getElementById('camPickFile'),
  flip:       document.getElementById('camFlip'),
  fileInput:  document.getElementById('camFileInput'),
  stage:      document.getElementById('cameraStage'),
  loading:    document.getElementById('camLoading'),
  loadingTxt: document.getElementById('camLoadingText'),
  result:     document.getElementById('camResult'),
  resultTitle:document.getElementById('camResultTitle'),
  retake:     document.getElementById('camRetake'),
  openPicker: document.getElementById('camOpenPicker'),
  photoCanvas:document.getElementById('camPhotoCanvas'),
  render:     document.getElementById('camRender'),
  value:      document.getElementById('camValue'),
  meta:       document.getElementById('camMeta'),
  bands:      document.getElementById('camBands'),
  hint:       document.getElementById('camHint'),
  error:      document.getElementById('camError'),
  errorText:  document.getElementById('camErrorText'),
  pickFallback:document.getElementById('camPickFallback'),

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
  const c = document.createElement('canvas');
  c.width = cam.video.videoWidth;
  c.height = cam.video.videoHeight;
  c.getContext('2d').drawImage(cam.video, 0, 0);
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
  // Hide live stage, show result
  stopCamera();
  cam.stage.style.display = 'none';
  cam.result.hidden = false;

  // Draw the photo on the result canvas
  const pc = cam.photoCanvas;
  const ctx = pc.getContext('2d');
  // Fit canvas to displayed width while preserving aspect
  pc.width = sourceCanvas.width;
  pc.height = sourceCanvas.height;
  ctx.drawImage(sourceCanvas, 0, 0);

  if (!result.success) {
    cam.resultTitle.textContent = "Couldn't read this";
    cam.value.textContent = '—';
    cam.meta.textContent = '';
    cam.bands.innerHTML = '';
    cam.render.innerHTML = '';
    cam.hint.textContent = result.reason || 'Please retake the photo.';
    cam.openPicker.style.visibility = 'hidden';
    return;
  }

  cam.openPicker.style.visibility = '';
  cam.resultTitle.textContent = `${result.mode}-band resistor`;

  // Render detected resistor
  cam.render.innerHTML = window.ResistorEngine.renderResistorSVG(result.picks, result.mode);

  // Value + meta
  cam.value.textContent = `${window.ResistorEngine.formatOhms(result.ohms)}  ± ${result.tol}%`;
  const e = window.ResistorEngine.nearestE24(result.ohms);
  let meta = '';
  if (e && e.exact) meta = 'E24 standard value ✓';
  else if (e) meta = `Nearest E24: ${window.ResistorEngine.formatOhms(e.standard)}`;
  cam.meta.textContent = meta;

  // Bands with per-band confidence
  cam.bands.innerHTML = '';
  result.bands.forEach((b) => {
    const c = window.ResistorEngine.COLOR_BY_ID[b.colorId];
    const pill = document.createElement('span');
    const isLow = b.confidence < 0.18;
    pill.className = 'camera__band' + (isLow ? ' camera__band--low' : '');
    pill.innerHTML = `<span class="camera__band-dot" style="background:${c.hex}"></span>${c.name}${isLow ? ' ?' : ''}`;
    cam.bands.appendChild(pill);
  });

  // Hint
  const anyLow = result.bands.some(b => b.confidence < 0.18);
  cam.hint.textContent = anyLow
    ? "Some bands looked uncertain — tap Edit to correct them."
    : "Tap Edit to fine-tune the result in the colour picker.";
}

// ---------- Event wiring ----------

cam.shutter.addEventListener('click', async () => {
  const c = captureFromVideo();
  if (c) await process(c);
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
  if (!cam.lastDetection || !cam.lastDetection.success) return;
  window.applyDetectedBands(cam.lastDetection.picks, cam.lastDetection.mode);
});

// Start/stop based on tab visibility
window.addEventListener('camera:enter', () => {
  if (!cam.result.hidden) return; // user still looking at result
  startCamera();
});
window.addEventListener('camera:leave', () => stopCamera());
window.addEventListener('beforeunload', stopCamera);
