"use client"

import ActivityPanel from "@/app/components/ActivityPanel"
import { PageHeader } from "@/app/components/PageHeader"

export default function ActivityPage() {
  return (
    <>
      <PageHeader title="Activity" description="Recent sandbox and gateway events." />
      <ActivityPanel />
    </>
  )
}
