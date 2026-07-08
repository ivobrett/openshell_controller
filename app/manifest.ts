import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenShell Controller",
    short_name: "OpenShell",
    description: "NVIDIA OpenShell sandbox controller",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#76b900",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  }
}
