"use client"

import WizardPanel from "@/app/components/WizardPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { useInventory } from "@/app/hooks/queries"

export default function WizardsPage() {
  const { sandboxes, refetch } = useInventory()
  const onInventoryRefresh = async () => {
    const r = await refetch()
    return r.data?.sandboxes ?? []
  }
  return (
    <>
      <PageHeader title="Wizards" description="Quick-deploy templates for common sandbox configurations." />
      <WizardPanel sandboxes={sandboxes} onInventoryRefresh={onInventoryRefresh} />
    </>
  )
}
