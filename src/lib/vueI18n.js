import { nextTick } from 'vue';
import { createI18n } from 'vue-i18n/dist/vue-i18n.esm-bundler';
import { supportLocales } from '@/utils/shared';
import dayjs from './dayjs';

const i18n = createI18n({
  locale: 'zh',
  legacy: false,
  fallbackLocale: 'en',
});

export function setI18nLanguage(locale = 'zh') {
  const validLocale = supportLocales.some(({ id }) => id === locale)
    ? locale
    : 'zh';

  i18n.global.locale.value = validLocale;

  dayjs.locale(validLocale.toLowerCase());
  document.documentElement.setAttribute('lang', validLocale);
}

export async function loadLocaleMessages(locale = 'zh', location = 'newtab') {
  if (!supportLocales.some(({ id }) => id === locale)) locale = 'zh';

  const importLocale = async (path, merge = false) => {
    try {
      const messages = await import(
        /* webpackChunkName: "locales/locale-[request]" */ `../locales/${locale}/${path}`
      );

      if (merge) {
        i18n.global.mergeLocaleMessage(locale, messages.default);
      } else {
        i18n.global.setLocaleMessage(locale, messages.default);
      }
    } catch (error) {
      console.error(error);
    }
  };

  if (locale !== 'en' && !i18n.global.availableLocales.includes('en')) {
    await loadLocaleMessages('en', location);
  }

  dayjs.locale(locale.toLowerCase());

  await importLocale('common.json');
  await importLocale('popup.json', true);
  await importLocale(`${location}.json`, true);
  await importLocale('blocks.json', true);

  return nextTick();
}

export default i18n;
