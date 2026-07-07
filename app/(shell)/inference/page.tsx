"use client"

import InferenceEndpointPanel from "@/app/components/InferenceEndpointPanel"
import { PageHeader } from "@/app/components/PageHeader"

export default function InferencePage() {
  return (
    <>
      <PageHeader title="Inference" description="Global inference endpoint configuration." />
      <InferenceEndpointPanel />
    </>
  )
}
