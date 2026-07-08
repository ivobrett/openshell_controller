import type { Capabilities } from "@/app/api/auth/me/route"
import {
  LayoutDashboard, Plus, ScrollText, BookOpen, Cpu, Plug, Sparkles, KeyRound, CircleHelp,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  cap?: keyof Capabilities
  mobileTab?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/",             label: "Dashboard",    icon: LayoutDashboard,   mobileTab: true },
  { href: "/sandboxes/new", label: "New sandbox", icon: Plus,              cap: "createSandbox" },
  { href: "/activity",     label: "Activity",     icon: ScrollText,        cap: "viewActivity",    mobileTab: true },
  { href: "/skills",       label: "Skills",       icon: BookOpen,          cap: "viewSkills" },
  { href: "/inference",    label: "Inference",    icon: Cpu,               cap: "manageInference" },
  { href: "/mcp",          label: "MCP",          icon: Plug,              cap: "manageMcp" },
  { href: "/wizards",      label: "Wizards",      icon: Sparkles,          cap: "viewWizards" },
  { href: "/security",     label: "Security",     icon: KeyRound },
  { href: "/help",         label: "Help",         icon: CircleHelp,        mobileTab: true },
]

export function visibleNavItems(caps: Capabilities | null): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.cap || Boolean(caps?.[item.cap]))
}
