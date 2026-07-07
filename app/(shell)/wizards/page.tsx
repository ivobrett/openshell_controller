"use client"

import WizardPanel from "@/app/components/WizardPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { useSandboxInventory } from "@/app/hooks/useSandboxInventory"

export default function WizardsPage() {
  const { sandboxes, refresh } = useSandboxInventory({ enabled: true })
  return (
    <>
      <PageHeader title="Wizards" description="Quick-deploy templates for common sandbox configurations." />
      <WizardPanel sandboxes={sandboxes} onInventoryRefresh={refresh} />
    </>
  )
}
