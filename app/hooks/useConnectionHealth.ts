"use client"
import { useInventory } from "./queries"

export function useConnectionHealth() {
  const { isReconnecting } = useInventory()
  return { reconnecting: isReconnecting }
}
