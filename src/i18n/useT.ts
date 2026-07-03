import { useContext } from 'react'
import { LanguageContext } from './context'

export function useT() {
  return useContext(LanguageContext)
}
