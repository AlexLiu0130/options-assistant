import { createContext } from 'react'
import { en } from './en'

type Lang = 'en' | 'zh'

export type { Lang }

export const LanguageContext = createContext<{
  lang: Lang
  setLang: (l: Lang) => void
  t: typeof en
}>({ lang: 'en', setLang: () => {}, t: en })
