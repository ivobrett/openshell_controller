import type { Readable } from "node:stream"

export function archiveMaxBytes(): number
export function archiveTimeoutMs(): number

export function formatArchiveBytes(value: number): string
export function shellQuote(value: string): string
export function normalizeArchiveSandboxPath(input: string | null | undefined): string
export function pickSandboxContainer(containerNames: string[], sandboxRef: string): string | null
export function findSandboxContainer(sandboxRef: string): Promise<string>
export function estimateSandboxPathBytes(containerName: string, targetPath: string): Promise<number | null>

export type SandboxBackupResult = { bytes: number; warning: string | null }
export function createSandboxBackupStream(options: {
  containerName: string
  targetPath: string
  maxBytes?: number
  timeoutMs?: number
}): { stream: Readable; done: Promise<SandboxBackupResult> }

export function receiveStreamToFile(readable: Readable, filePath: string, maxBytes?: number): Promise<number>

export function restoreArchiveFileIntoSandbox(options: {
  containerName: string
  hostFile: string
  targetPath: string
  replace: boolean
  token: string
}): Promise<void>
