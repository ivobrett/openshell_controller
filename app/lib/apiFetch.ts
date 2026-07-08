export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init })

  if (response.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      const next = encodeURIComponent(
        window.location.pathname + window.location.search,
      )
      window.location.href = `/login?next=${next}`
    }
    throw new ApiError(401, "Session expired")
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`)
    throw new ApiError(500, "Unexpected non-JSON response")
  }

  if (!response.ok) {
    const b = body as Record<string, unknown> | null
    throw new ApiError(response.status, (b?.error as string) || `Request failed (${response.status})`, body)
  }
  return body as T
}
