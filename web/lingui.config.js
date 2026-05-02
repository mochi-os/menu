/** @type {import('@lingui/conf').LinguiConfig} */
export default {
  sourceLocale: 'en',
  locales: ['en', 'en-US', 'fr', 'ja', 'ar', 'zh-hans', 'zh-hant', 'ko', 'id', 'th', 'tl'],
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src/**/*.{ts,tsx}', '../../../lib/web/src/**/*.{ts,tsx}'],
    },
  ],
  format: 'po',
  compileNamespace: 'es',
}
