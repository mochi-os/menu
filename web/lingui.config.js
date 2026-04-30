/** @type {import('@lingui/conf').LinguiConfig} */
export default {
  sourceLocale: 'en',
  locales: ['en', 'en-US', 'fr', 'ja'],
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src'],
    },
  ],
  format: 'po',
  compileNamespace: 'es',
}
