"use client"

import { useRouter } from "next/navigation"
import ConfigurationPanel from "@/app/components/ConfigurationPanel"
import { PageHeader } from "@/app/components/PageHeader"

export default function NewSandboxPage() {
  const router = useRouter()

  const handleCreateSuccess = async (createdSandboxId: string) => {
    router.push("/")
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
