(function () {
  const ramp = ' .,:;irsXA253hMHGS#9B&@';
  const running = new WeakSet();
  const watchedSource = new WeakMap();

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

  async function asciiify(img) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:image/') || running.has(img)) return;
    if (img.dataset.asciiSource === src) return;

    running.add(img);
    let cleanup = null;
    try {
      const readable = await readableSource(img, src);
      const source = readable.image;
      cleanup = readable.cleanup;
      const compact = img.classList.contains('thumb') || img.classList.contains('yt-thumb');
      const columns = compact ? 18 : 38;
      const cellWidth = 5;
      const cellHeight = 8;
      const rows = Math.max(1, Math.round(columns * (source.naturalHeight / source.naturalWidth) * (cellWidth / cellHeight)));

      const sample = document.createElement('canvas');
      sample.width = columns;
      sample.height = rows;
      const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
      sampleCtx.drawImage(source, 0, 0, columns, rows);
      const pixels = sampleCtx.getImageData(0, 0, columns, rows).data;

      const output = document.createElement('canvas');
      output.width = columns * cellWidth;
      output.height = rows * cellHeight;
      const ctx = output.getContext('2d');
      ctx.fillStyle = '#070807';
      ctx.fillRect(0, 0, output.width, output.height);
      ctx.font = '8px SFMono-Regular, Consolas, Liberation Mono, monospace';
      ctx.textBaseline = 'top';

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          const index = (y * columns + x) * 4;
          const luminance = Math.round(
            pixels[index] * 0.2126 +
            pixels[index + 1] * 0.7152 +
            pixels[index + 2] * 0.0722
          );
          const glyph = ramp[Math.min(ramp.length - 1, Math.floor((luminance / 256) * ramp.length))];
          if (glyph === ' ') continue;
          const tone = Math.min(240, 86 + Math.round(luminance * 0.62));
          ctx.fillStyle = `rgb(${tone}, ${Math.min(246, tone + 5)}, ${Math.min(242, tone + 2)})`;
          ctx.fillText(glyph, x * cellWidth, y * cellHeight);
        }
      }

      img.dataset.asciiSource = src;
      img.src = output.toDataURL('image/png');
      img.classList.add('ascii-rendered');
    } catch (_) {
      img.classList.add('ascii-fallback');
    } finally {
      if (cleanup) cleanup();
      running.delete(img);
    }
  }

  const visibilityObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      visibilityObserver.unobserve(entry.target);
      asciiify(entry.target);
    });
  }, { rootMargin: '160px' });

  function watch(img) {
    if (!(img instanceof HTMLImageElement)) return;
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:image/') || watchedSource.get(img) === src) return;
    watchedSource.set(img, src);
    if (img.complete && img.naturalWidth) asciiify(img);
    else {
      img.addEventListener('load', () => asciiify(img), { once: true });
      visibilityObserver.observe(img);
    }
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
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();
