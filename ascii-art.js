(function () {
  const ramp = ' .,:;irsXA253hMHGS#9B&@';
  const frameInterval = 1000 / 10;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const running = new WeakSet();
  const watchedSource = new WeakMap();
  const stateForImage = new WeakMap();
  const stateForCanvas = new WeakMap();
  const scenes = new Set();
  let animationFrame = 0;
  let animationTimer = 0;
  let lastFrameAt = 0;
  let renderIndex = 0;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const imageSource = img => img.getAttribute('src') ? (img.src || img.currentSrc) : '';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function readableSource(img, src) {
    const url = new URL(src, location.href);
    if (url.origin === location.origin) {
      const image = img.complete && img.naturalWidth ? img : await loadImage(url.href);
      return { image, cleanup: null };
    }

    const response = await fetch(url.href, { mode: 'cors' });
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    return {
      image: await loadImage(objectUrl),
      cleanup: () => URL.revokeObjectURL(objectUrl)
    };
  }

  function noise(x, y, step, seed) {
    let value = Math.imul(x + 1, 374761393);
    value = (value + Math.imul(y + 1, 668265263)) | 0;
    value = (value + Math.imul(step + 1, 69069) + Math.imul(seed + 1, 362437)) | 0;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function frameClasses(img) {
    const classes = ['ascii-frame'];
    img.classList.forEach(className => {
      if (!['loaded', 'ascii-source', 'ascii-fallback'].includes(className)) classes.push(className);
    });
    return classes.join(' ');
  }

  function fallbackFor(img) {
    const coverFallback = img.closest('.cover')?.querySelector('.fallback');
    if (coverFallback) return coverFallback;
    return img.closest('.top-row')?.querySelector('.thumb-empty') || null;
  }

  function syncFrameDisplay(state) {
    if (state.img.id !== 'np-art') return;
    state.frame.style.display = state.img.style.display;
  }

  function mountFrame(img) {
    const existing = stateForImage.get(img);
    if (existing) return existing;

    const frame = document.createElement('span');
    frame.className = frameClasses(img);
    if (img.closest('.cover')) frame.classList.add('ascii-cover-frame');
    if (img.id === 'np-art') {
      frame.classList.add('ascii-inline-frame');
      frame.style.cssText = img.style.cssText;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'ascii-rendered';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', img.alt || '');
    canvas.dataset.asciiState = motionPreference.matches ? 'paused' : 'animated';
    canvas.dataset.asciiFrame = '0';

    const parent = img.parentNode;
    const fallback = fallbackFor(img);
    if (fallback) fallback.style.display = 'none';
    parent.insertBefore(frame, img);
    frame.append(img, canvas);
    img.classList.add('ascii-source');
    img.setAttribute('aria-hidden', 'true');

    const state = {
      img,
      frame,
      canvas,
      ctx: canvas.getContext('2d'),
      source: '',
      cells: [],
      columns: 0,
      rows: 0,
      cellWidth: 5,
      cellHeight: 8,
      seed: renderIndex % 23,
      frameCount: 0,
      visible: false
    };
    renderIndex += 1;
    stateForImage.set(img, state);
    stateForCanvas.set(canvas, state);
    scenes.add(state);
    canvasVisibility.observe(canvas);
    syncFrameDisplay(state);
    return state;
  }

  function sampleSource(state, source) {
    const compact = state.img.classList.contains('thumb') || state.img.classList.contains('yt-thumb');
    const columns = compact ? 18 : 42;
    const rows = Math.max(
      1,
      Math.round(columns * (source.naturalHeight / source.naturalWidth) * (state.cellWidth / state.cellHeight))
    );
    const sample = document.createElement('canvas');
    sample.width = columns;
    sample.height = rows;
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    sampleCtx.drawImage(source, 0, 0, columns, rows);
    const pixels = sampleCtx.getImageData(0, 0, columns, rows).data;
    const cells = [];

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const index = (y * columns + x) * 4;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
        cells.push({
          x,
          y,
          red,
          green,
          blue,
          luminance,
          glyph: Math.min(ramp.length - 1, Math.floor((luminance / 256) * ramp.length))
        });
      }
    }

    state.columns = columns;
    state.rows = rows;
    state.cells = cells;
    state.canvas.width = columns * state.cellWidth;
    state.canvas.height = rows * state.cellHeight;
    state.ctx.font = '700 8px SFMono-Regular, Consolas, Liberation Mono, monospace';
    state.ctx.textBaseline = 'top';
  }

  function drawScene(state, timestamp, animated) {
    if (!state.cells.length) return;
    const { ctx, columns, rows, cellWidth, cellHeight } = state;
    const step = animated ? Math.floor(timestamp / frameInterval) : 0;
    const cycle = columns + rows * 0.72 + 18;
    const sweep = animated
      ? ((timestamp / 2800 + state.seed * 0.071) % 1) * cycle - 9
      : -100;

    ctx.fillStyle = '#070807';
    ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);

    state.cells.forEach(cell => {
      const diagonal = cell.x + (rows - 1 - cell.y) * 0.72;
      const distance = Math.abs(diagonal - sweep);
      const wave = animated ? Math.max(0, 1 - distance / 9) : 0;
      const random = noise(cell.x, cell.y, step, state.seed);
      const shimmer = animated && wave === 0 && random > 0.975 ? 1 : 0;
      const shift = Math.round(wave * (4 + random * 4)) + shimmer;
      const glyphIndex = clamp(cell.glyph + shift, 0, ramp.length - 1);
      const glyph = ramp[glyphIndex];
      if (glyph === ' ') return;

      const brightness = 72 + cell.luminance * 0.76 + wave * 62 + shimmer * 20;
      const color = channel => clamp(
        Math.round(brightness + (channel - cell.luminance) * 1.5),
        0,
        255
      );
      ctx.fillStyle = `rgb(${color(cell.red)}, ${color(cell.green)}, ${color(cell.blue)})`;
      ctx.fillText(glyph, cell.x * cellWidth, cell.y * cellHeight);
    });

    if (animated) state.frameCount += 1;
    else state.frameCount = 0;
    state.canvas.dataset.asciiFrame = String(state.frameCount);
    state.canvas.dataset.asciiState = animated ? 'animated' : 'paused';
  }

  function showScene(state) {
    const fallback = fallbackFor(state.img);
    if (fallback) fallback.style.display = 'none';
    state.canvas.style.visibility = 'visible';
    if (state.img.id === 'np-art') syncFrameDisplay(state);
    else state.frame.style.removeProperty('display');
  }

  function hideScene(state, status) {
    state.visible = false;
    state.canvas.dataset.asciiState = status;
    state.canvas.style.visibility = 'hidden';
    state.frame.style.display = 'none';
    const fallback = fallbackFor(state.img);
    if (fallback) fallback.style.display = 'flex';
  }

  function disconnectScene(state) {
    canvasVisibility.unobserve(state.canvas);
    scenes.delete(state);
  }

  function stopAnimation() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (animationTimer) clearTimeout(animationTimer);
    animationFrame = 0;
    animationTimer = 0;
  }

  function requestAnimation() {
    if (animationFrame || animationTimer || motionPreference.matches || document.hidden) return;
    const delay = Math.max(0, frameInterval - (performance.now() - lastFrameAt));
    animationTimer = window.setTimeout(() => {
      animationTimer = 0;
      animationFrame = requestAnimationFrame(animateScenes);
    }, delay);
  }

  function animateScenes(timestamp) {
    animationFrame = 0;
    if (motionPreference.matches || document.hidden) return;
    lastFrameAt = timestamp;
    let hasVisibleScene = false;

    scenes.forEach(state => {
      if (!state.frame.isConnected) {
        disconnectScene(state);
        return;
      }
      if (!state.visible) return;
      if (['error', 'loading'].includes(state.canvas.dataset.asciiState)) return;
      hasVisibleScene = true;
      drawScene(state, timestamp, true);
    });

    if (hasVisibleScene) requestAnimation();
  }

  const canvasVisibility = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const state = stateForCanvas.get(entry.target);
      if (!state) return;
      state.visible = entry.isIntersecting;
      if (state.visible) requestAnimation();
    });
  }, { rootMargin: '80px' });

  async function asciiify(img) {
    if (img.dataset.ascii === 'off') return;
    const src = imageSource(img);
    if (!src || src.startsWith('data:image/') || running.has(img)) return;
    const existing = stateForImage.get(img);
    if (existing?.source === src && !['error', 'loading'].includes(existing.canvas.dataset.asciiState)) return;

    running.add(img);
    let cleanup = null;
    try {
      const readable = await readableSource(img, src);
      cleanup = readable.cleanup;
      const state = mountFrame(img);
      sampleSource(state, readable.image);
      state.source = src;
      state.canvas.dataset.asciiSource = src;
      drawScene(state, performance.now(), false);
      showScene(state);
      img.classList.remove('ascii-fallback');
      requestAnimation();
    } catch (_) {
      img.classList.add('ascii-fallback');
      watchedSource.delete(img);
      const state = stateForImage.get(img);
      if (state) hideScene(state, 'error');
    } finally {
      if (cleanup) cleanup();
      running.delete(img);
      const current = imageSource(img);
      if (current && current !== src) {
        watchedSource.delete(img);
        watch(img);
      }
    }
  }

  const sourceVisibility = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      sourceVisibility.unobserve(entry.target);
      asciiify(entry.target);
    });
  }, { rootMargin: '160px' });

  function watch(img) {
    if (!(img instanceof HTMLImageElement)) return;
    const state = stateForImage.get(img);
    if (state) syncFrameDisplay(state);
    if (img.dataset.ascii === 'off') return;
    const src = imageSource(img);
    const retryingError = state?.canvas.dataset.asciiState === 'error';
    if (!src || src.startsWith('data:image/') || (watchedSource.get(img) === src && !retryingError)) return;
    watchedSource.set(img, src);
    if (state && state.source && state.source !== src) hideScene(state, 'loading');
    if (img.complete && img.naturalWidth) asciiify(img);
    else {
      img.addEventListener('load', () => asciiify(img), { once: true });
      img.addEventListener('error', () => {
        watchedSource.delete(img);
        const failedState = stateForImage.get(img);
        if (failedState) hideScene(failedState, 'error');
      }, { once: true });
      sourceVisibility.observe(img);
    }
  }

  function applyMotionPreference() {
    stopAnimation();
    scenes.forEach(state => {
      if (!['error', 'loading'].includes(state.canvas.dataset.asciiState)) drawScene(state, 0, false);
    });
    if (!motionPreference.matches) requestAnimation();
  }

  document.querySelectorAll('img').forEach(watch);

  new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'attributes') {
        watch(mutation.target);
        return;
      }
      mutation.addedNodes.forEach(node => {
        if (node instanceof HTMLImageElement) watch(node);
        else if (node instanceof Element) node.querySelectorAll('img').forEach(watch);
      });
      mutation.removedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        const canvases = node.matches('canvas.ascii-rendered')
          ? [node]
          : node.querySelectorAll('canvas.ascii-rendered');
        canvases.forEach(canvas => {
          const state = stateForCanvas.get(canvas);
          if (state && !state.frame.isConnected) disconnectScene(state);
        });
        const removedImages = node instanceof HTMLImageElement
          ? [node]
          : node.querySelectorAll('img');
        removedImages.forEach(img => {
          const state = stateForImage.get(img);
          if (state && !state.frame.isConnected) disconnectScene(state);
        });
      });
    });
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'style']
  });

  motionPreference.addEventListener('change', applyMotionPreference);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAnimation();
    else requestAnimation();
  });
})();
