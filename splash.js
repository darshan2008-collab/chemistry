(function () {
  const fill = document.getElementById('loaderFill');
  const totalMs = window.matchMedia('(max-width: 640px)').matches ? 1100 : 1300;
  const start = performance.now();

  function frame(now) {
    const progress = Math.min(1, (now - start) / totalMs);
    if (fill) fill.style.width = `${Math.round(progress * 100)}%`;

    if (progress < 1) {
      requestAnimationFrame(frame);
      return;
    }

    try {
      sessionStorage.setItem('chemtest_prelogin_ok', '1');
    } catch (_err) {
      // Ignore storage errors and continue navigation.
    }

    window.location.replace('login.html');
  }

  requestAnimationFrame(frame);
})();
