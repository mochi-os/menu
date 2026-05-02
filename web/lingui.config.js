/** @type {import('@lingui/conf').LinguiConfig} */
export default {
  sourceLocale: 'en',
  locales: ['en', 'en-US', 'fr', 'ja', 'ar', 'en-x-pseudo'],
  pseudoLocale: 'en-x-pseudo',
  fallbackLocales: { 'en-x-pseudo': 'en' },
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src/**/*.{ts,tsx}', '../../../lib/web/src/**/*.{ts,tsx}'],
    },
  ],
  format: 'po',
  compileNamespace: 'es',
}
