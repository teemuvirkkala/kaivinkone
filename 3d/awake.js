// The phone's screen stays on while the page is open (#255): a build beside the pieces takes tens of minutes. The
// browser lets a screen wake lock go whenever the page is hidden, so it is asked for again each time the page is shown.
// A browser that refuses (low battery, no user gesture yet) or hasn't the API just lets the screen sleep.
export function keepAwake(nav = navigator, doc = document) {
  const ask = () => {
    if (doc.visibilityState === 'visible') nav.wakeLock?.request('screen').catch(() => {});
  };
  doc.addEventListener('visibilitychange', ask);
  ask();
}
