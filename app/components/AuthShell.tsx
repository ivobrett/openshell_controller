"use client"

import type { ReactNode } from "react"
import { Card } from "@/app/components/ui/card"

export default function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Product mark */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect width="40" height="40" rx="4" fill="hsl(var(--primary))" />
            <path
              d="M20 8 L32 15 L32 25 L20 32 L8 25 L8 15 Z"
              fill="none"
              stroke="black"
              strokeWidth="1.5"
              strokeLinejoin="miter"
            />
            <path
              d="M20 8 L20 32 M8 15 L32 15 M8 25 L32 25 M8 15 L20 8 M32 15 L20 8 M8 25 L20 32 M32 25 L20 32"
              stroke="black"
              strokeWidth="1"
              opacity="0.4"
            />
          </svg>
          <div>
            <h1 className="text-base font-semibold tracking-tight">{title}</h1>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        <Card className="p-6">
          {children}
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          OpenShell Control
        </p>
      </div>
    </main>
  )
}
