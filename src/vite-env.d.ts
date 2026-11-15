/// <reference types="vite/client" />

interface Window {
  /**
   * Reload the page to show a newer interface that is already in place (set by App). The app calls it while the
   * window is closed, with `asked` false: the page can say no (false) while something of its own is still going on.
   */
  __rewatchReload?: (asked: boolean) => boolean;
}
