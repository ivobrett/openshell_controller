import { redirect } from "next/navigation"
import { isAuthConfigured } from "@/app/lib/auth/context"
import FirstRunSetup from "./FirstRunSetup"

export default function SetupAccountPage() {
  if (isAuthConfigured()) redirect("/security")
  return <FirstRunSetup />
}
