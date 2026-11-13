// Applies a saved light/dark choice before first paint (kept tiny and synchronous).
try {
  const theme = JSON.parse(localStorage.getItem('deskport.settings') || '{}').theme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
