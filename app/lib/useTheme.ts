"use client"
import { useEffect, useState } from "react"

type Theme = "dark" | "light"
const KEY = "openshell-control.theme"

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark")

  useEffect(() => {
    const stored = localStorage.getItem(KEY)
    if (stored === "light" || stored === "dark") setTheme(stored)
  }, [])

  const toggle = () => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark"
      localStorage.setItem(KEY, next)
      document.documentElement.dataset.theme = next
      return next
    })
  }

  return { theme, toggle }
}
