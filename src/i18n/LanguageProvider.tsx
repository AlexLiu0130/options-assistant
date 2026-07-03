import { useState } from 'react'
import type { ReactNode } from 'react'
import { en } from './en'
import { zh } from './zh'
import { LanguageContext } from './context'
import type { Lang } from './context'

const dict = { en, zh }

export function LanguageProvider({ children }: { children: ReactNode }) {
  const stored = (localStorage.getItem('qveris-lang') as Lang | null) ?? 'en'
  const [lang, setLangState] = useState<Lang>(stored)

  function setLang(l: Lang) {
    localStorage.setItem('qveris-lang', l)
    setLangState(l)
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: dict[lang] }}>
      {children}
    </LanguageContext.Provider>
  )
}
