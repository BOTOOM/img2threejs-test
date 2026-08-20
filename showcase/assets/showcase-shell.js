(() => {
  const root = document.documentElement;
  const workspace = document.getElementById('workspace');
  const frame = document.getElementById('demo');
  const empty = document.getElementById('emptyState');
  const status = document.getElementById('status');
  const launch = document.getElementById('launchBtn');
  const launchEmpty = document.getElementById('launchEmptyBtn');
  const split = document.getElementById('splitBtn');
  const reload = document.getElementById('reloadBtn');
  const thumb = document.getElementById('referenceThumb');
  const pass = document.getElementById('passSelect');
  const params = new URLSearchParams(window.location.search);
  let loaded = false;
  let loadingTimer = 0;

  const setStatus = (message, state = 'ready') => {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message;
    status.dataset.state = state;
  };

  const getDemoUrl = () => {
    const query = new URLSearchParams();
    if (pass) query.set('pass', pass.value);
    query.set('live', '1');
    return `demo.html?${query.toString()}`;
  };

  const setControls = (enabled) => {
    if (split) split.disabled = !enabled;
    if (reload) reload.disabled = !enabled;
    if (launch) launch.disabled = enabled;
  };

  const loadScene = () => {
    if (!frame || loaded) return;
    loaded = true;
    setControls(false);
    setStatus('Preparing the interactive scene…');
    if (empty) empty.hidden = true;
    frame.hidden = false;
    frame.src = getDemoUrl();
    window.clearTimeout(loadingTimer);
    loadingTimer = window.setTimeout(() => {
      if (!frame.dataset.ready) setStatus('The scene is taking longer than expected. Check the browser console if it does not appear.', 'error');
    }, 12000);
  };

  const reloadScene = () => {
    if (!loaded) return loadScene();
    setStatus('Reloading the interactive scene…');
    frame.dataset.ready = '';
    frame.contentWindow.location.reload();
  };

  const toggleSplit = () => {
    if (!loaded) loadScene();
    const active = workspace.classList.toggle('split');
    split?.setAttribute('aria-pressed', String(active));
    if (split) split.textContent = active ? 'Compare on' : 'Compare';
  };

  frame?.addEventListener('load', () => {
    const expectsHandshake = frame.src.includes('pass=');
    if (!expectsHandshake) {
      frame.dataset.ready = 'true';
      window.clearTimeout(loadingTimer);
      setControls(true);
      setStatus('Interactive scene ready · drag to orbit');
      return;
    }

    const deadline = Date.now() + 20000;
    const waitForHandshake = () => {
      const innerStatus = frame.contentDocument?.getElementById('status')?.textContent ?? '';
      if (frame.contentWindow?.harnessReady) {
        frame.dataset.ready = 'true';
        window.clearTimeout(loadingTimer);
        setControls(true);
        setStatus('Interactive scene ready · drag to orbit');
      } else if (innerStatus.startsWith('Scene failed to initialize:')) {
        window.clearTimeout(loadingTimer);
        setControls(false);
        setStatus(innerStatus, 'error');
      } else if (Date.now() < deadline) {
        window.setTimeout(waitForHandshake, 100);
      } else {
        setControls(false);
        setStatus('The scene could not finish initializing. Try Reload or choose another pass.', 'error');
      }
    };
    waitForHandshake();
  });

  launch?.addEventListener('click', loadScene);
  launchEmpty?.addEventListener('click', loadScene);
  reload?.addEventListener('click', reloadScene);
  split?.addEventListener('click', toggleSplit);
  thumb?.addEventListener('click', toggleSplit);
  pass?.addEventListener('change', () => {
    if (loaded) {
      loaded = false;
      frame.dataset.ready = '';
      if (empty) empty.hidden = false;
      setControls(false);
      loadScene();
    }
  });

  if (params.get('autostart') === '1') loadScene();
  else setControls(false);
  root.dataset.shellReady = 'true';
})();
