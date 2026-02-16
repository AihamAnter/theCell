import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './en.json'
import ar from './ar.json'

const LANG_KEY = 'thecell_lang'

function getSavedLang(): 'en' | 'ar' {
  const raw = (localStorage.getItem(LANG_KEY) ?? '').trim().toLowerCase()
  return raw === 'ar' ? 'ar' : 'en'
}

function applyDocLang(lang: 'en' | 'ar') {
  const html = document.documentElement
  html.lang = lang
  html.dir = lang === 'ar' ? 'rtl' : 'ltr'
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en as any },
      ar: { translation: ar as any }
    },
    lng: getSavedLang(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false }
  })
  .then(() => applyDocLang((i18n.language as any) === 'ar' ? 'ar' : 'en'))

i18n.on('languageChanged', (lng) => {
  const lang = lng === 'ar' ? 'ar' : 'en'
  localStorage.setItem(LANG_KEY, lang)
  applyDocLang(lang)
})

export default i18n
