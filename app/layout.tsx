import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "./components/providers/Providers"

export const metadata: Metadata = {
  title: "OpenShell/NemoClaw Dashboard",
  description: "Control plane dashboard for OpenShell and NemoClaw",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html:
          `try{var t=localStorage.getItem('openshell-control.theme');if(t)document.documentElement.dataset.theme=t}catch(e){}` }} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
