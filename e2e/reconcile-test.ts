import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

// Optional settings are collapsed for people; tests open them as they appear.
export const test = base.extend({
  page: async ({ page }, provide) => {
    await page.addInitScript(() => {
      const open = () => document.querySelectorAll('details.optional-fields:not([open])').forEach((d) => d.setAttribute('open', ''))
      new MutationObserver(open).observe(document, { childList: true, subtree: true })
    })
    await provide(page)
  },
})
