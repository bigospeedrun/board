// Runs before the page paints, so a saved theme does not flash (as on the site).
try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}
