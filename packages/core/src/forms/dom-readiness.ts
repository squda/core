import type { Page } from 'playwright';

/** Wait until live DOM mutations stop briefly, bounded by the caller's budget. */
export async function waitForDomQuiet(page: Page, budgetMs: number): Promise<void> {
  const budget = Math.max(1, Math.floor(budgetMs));
  const quiet = Math.min(300, budget);
  // A source string avoids tsx/esbuild's Node-side function-name helper being
  // serialized into Chromium, where that helper does not exist.
  await page.evaluate(String.raw`(() => new Promise((resolve) => {
    let quietTimer;
    let budgetTimer;
    let observer;
    const done = () => {
      observer.disconnect();
      window.clearTimeout(quietTimer);
      window.clearTimeout(budgetTimer);
      resolve();
    };
    quietTimer = window.setTimeout(done, ${quiet});
    budgetTimer = window.setTimeout(done, ${budget});
    observer = new MutationObserver(() => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(done, ${quiet});
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }))()`);
}
