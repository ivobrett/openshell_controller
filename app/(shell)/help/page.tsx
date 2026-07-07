"use client"

import { useState } from "react"
import HelpPanel from "@/app/components/HelpPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { useSandboxInventory } from "@/app/hooks/useSandboxInventory"

const TELEMETRY_BAR_ENABLED_KEY = "openshell-control.telemetry-bar-enabled"

export default function HelpPage() {
  const { sandboxes } = useSandboxInventory({ enabled: false })
  const [telemetryBarEnabled, setTelemetryBarEnabled] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(TELEMETRY_BAR_ENABLED_KEY) === "true"
  })

  const handleTelemetryChange = (enabled: boolean) => {
    setTelemetryBarEnabled(enabled)
    window.localStorage.setItem(TELEMETRY_BAR_ENABLED_KEY, enabled ? "true" : "false")
  }

  return (
    <>
      <PageHeader title="Help" description="Documentation and shortcuts for OpenShell Control." />
      <HelpPanel
        sandboxes={sandboxes}
        telemetryBarEnabled={telemetryBarEnabled}
        onTelemetryBarEnabledChange={handleTelemetryChange}
      />
    </>
  )
}
