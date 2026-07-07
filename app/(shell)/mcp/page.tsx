"use client"

import McpConfigurationPanel from "@/app/components/McpConfigurationPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { useInventory } from "@/app/hooks/queries"

export default function McpPage() {
  const { sandboxes } = useInventory()
  return (
    <>
      <PageHeader title="MCP" description="Model Context Protocol server configuration." />
      <McpConfigurationPanel sandboxes={sandboxes} />
    </>
  )
}
