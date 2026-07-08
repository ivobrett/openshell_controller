"use client"

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import ConfigurationPanel from "@/app/components/ConfigurationPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { queryClient } from "@/app/lib/queryClient"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"

function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms))
}

// §5.5 — poll inventory until the freshly created sandbox appears, then land
// on its detail page. Mirrors DeleteSandboxDialog's refetchUntilGone.
async function refetchUntilVisible(name: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    await queryClient.refetchQueries({ queryKey: ["inventory"] })
    const data = queryClient.getQueryData<{ sandboxes: SandboxInventoryItem[] }>(["inventory"])
    const sandboxes = data?.sandboxes ?? []
    if (sandboxes.find((s) => s.id === name || s.name === name)) return true
    await sleep(1500)
  }
  return false
}

export default function NewSandboxPage() {
  const router = useRouter()

  const handleCreateSuccess = async (createdSandboxId: string) => {
    toast.loading(`Creating ${createdSandboxId}…`, { id: `create-${createdSandboxId}` })
    const visible = await refetchUntilVisible(createdSandboxId)
    if (visible) {
      toast.success(`Sandbox ${createdSandboxId} created`, { id: `create-${createdSandboxId}` })
    } else {
      toast.warning(`Created ${createdSandboxId}. Inventory hasn't reported it yet.`, {
        id: `create-${createdSandboxId}`,
      })
    }
    router.push(`/sandboxes/${encodeURIComponent(createdSandboxId)}`)
  }

  return (
    <>
      <PageHeader
        title="Create sandbox"
        description="Choose a blueprint, name the sandbox, and create it."
      />
      <ConfigurationPanel sandboxId="new-sandbox" mode="create" onCreateSuccess={handleCreateSuccess} />
    </>
  )
}
