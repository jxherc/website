(function () {
  const overlay    = document.getElementById('meme-overlay');
  const confirmBtn = document.getElementById('meme-confirm');
  const cancelBtn  = document.getElementById('meme-cancel');
  const toggleBtn  = document.getElementById('theme-toggle');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    if (toggleBtn) toggleBtn.textContent = theme === 'light' ? '●' : '◐';
  }

  const saved = localStorage.getItem('theme');
  if (saved && toggleBtn) toggleBtn.textContent = saved === 'light' ? '●' : '◐';

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      if (current === 'light') { applyTheme('dark'); return; }
      if (overlay) overlay.classList.add('visible');
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => overlay.classList.remove('visible'));
  }

  if (overlay) {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      const countdownEl = document.createElement('div');
      countdownEl.className = 'meme-countdown';
      confirmBtn.replaceWith(countdownEl);
      if (cancelBtn) cancelBtn.style.display = 'none';
      let n = 3;
      countdownEl.textContent = n;
      const iv = setInterval(() => {
        n--;
        if (n > 0) { countdownEl.textContent = n; return; }
        clearInterval(iv);
        overlay.classList.remove('visible');
        applyTheme('light');
        setTimeout(() => {
          countdownEl.replaceWith(confirmBtn);
          if (cancelBtn) cancelBtn.style.display = '';
        }, 400);
      }, 800);
    });
  }
})();
