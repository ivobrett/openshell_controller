"use client"

import { useState, useEffect } from "react"
import McpConfigurationPanel from "@/app/components/McpConfigurationPanel"
import { PageHeader } from "@/app/components/PageHeader"
import { useSandboxInventory } from "@/app/hooks/useSandboxInventory"

export default function McpPage() {
  const { sandboxes } = useSandboxInventory({ enabled: true })
  return (
    <>
      <PageHeader title="MCP" description="Model Context Protocol server configuration." />
      <McpConfigurationPanel sandboxes={sandboxes} />
    </>
  )
}
