/** @type {import('@lingui/conf').LinguiConfig} */
export default {
  sourceLocale: 'en',
  locales: ['en', 'en-us', 'fr', 'ja', 'ar', 'zh-hans', 'zh-hant', 'ko', 'id', 'th', 'tl', 'pt', 'pt-br', 'de', 'sv', 'nl', 'pl', 'he', 'it', 'hi', 'ur', 'vi', 'el', 'ru', 'uk', 'cs', 'hu', 'da', 'fi', 'nb', 'is', 'ms', 'es'],
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src/**/*.{ts,tsx}', '../../../lib/web/src/**/*.{ts,tsx}'],
    },
  ],
  format: 'po',
  compileNamespace: 'es',
}
