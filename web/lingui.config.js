/** @type {import('@lingui/conf').LinguiConfig} */
export default {
  sourceLocale: 'en',
  locales: ['en', 'en-us', 'fr', 'ja', 'ar', 'zh-hans', 'zh-hant', 'ko', 'id', 'th', 'tl', 'pt', 'pt-br', 'de', 'sv', 'nl', 'pl', 'he', 'it', 'hi', 'ur', 'vi', 'el', 'ru', 'uk', 'cs', 'hu', 'da', 'fi', 'nb', 'is', 'ms', 'es-419', 'es', 'nl-be', 'af', 'sw', 'yo', 'ha', 'am', 'zu', 'xh', 'bn', 'ta', 'te', 'mr', 'kn', 'ml', 'gu', 'pa', 'si', 'ne', 'tr', 'fa', 'ro', 'bg', 'hr', 'sr', 'sk', 'sl', 'ca', 'et', 'lv', 'lt', 'sq', 'be', 'mk', 'bs', 'yi', 'my', 'ps', 'kk', 'uz', 'az', 'km', 'lo', 'mn', 'cy', 'ga', 'gd', 'mt', 'eu', 'gl', 'tg', 'ky', 'tk', 'qu', 'ay', 'gn', 'ht', 'hy', 'ckb', 'ku', 'ka', 'fr-ca', 'zh-hk', 'de-ch', 'nn', 'en-ca', 'es-ar'],
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src/**/*.{ts,tsx}', '../../../lib/web/src/**/*.{ts,tsx}'],
    },
  ],
  fallbackLocales: {
    'fr-ca': 'fr',
    'zh-hk': 'zh-hant',
    'es-ar': 'es-419',
    'de-ch': 'de',
    'en-ca': 'en',
  },
  format: 'po',
  compileNamespace: 'es-419',
}
