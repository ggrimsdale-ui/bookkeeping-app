import type { Api, ApiMethod } from '../../shared/api'
import type { ClosingOverride } from '../../shared/types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly closedPeriod?: { closingDate: string; needsPassword: boolean },
    readonly reconciledChange?: boolean
  ) {
    super(message)
  }
}

/** Thrown when the user cancels a prompt; callers ignore it. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

type Promisified = { [K in ApiMethod]: (...args: Parameters<Api[K]>) => Promise<Awaited<ReturnType<Api[K]>>> }

export const api = new Proxy({} as Promisified, {
  get:
    (_target, method: string) =>
    async (...args: unknown[]) => {
      const result = await window.bridge.call(method as ApiMethod, args)
      if (!result.ok) throw new ApiError(result.error, result.closedPeriod, result.reconciledChange)
      return result.value
    }
})

export interface ClosingPrompts {
  password(message: string): Promise<string | null>
  confirm(message: string): Promise<boolean>
}

/**
 * Runs a change and, if it touches a closed period or a reconciled
 * transaction, asks for the closing password or a confirmation and retries.
 */
export async function withClosingOverride<T>(prompts: ClosingPrompts, fn: (override?: ClosingOverride) => Promise<T>): Promise<T> {
  const override: ClosingOverride = {}
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt === 0 ? undefined : { ...override })
    } catch (err) {
      if (!(err instanceof ApiError) || attempt >= 3) throw err
      if (err.closedPeriod && !override.closingPassword && !override.confirmClosedPeriod) {
        if (err.closedPeriod.needsPassword) {
          const password = await prompts.password(err.message)
          if (password === null) throw new Cancelled()
          override.closingPassword = password
        } else {
          if (!(await prompts.confirm(err.message))) throw new Cancelled()
          override.confirmClosedPeriod = true
        }
      } else if (err.reconciledChange && !override.confirmReconciled) {
        if (!(await prompts.confirm(err.message))) throw new Cancelled()
        override.confirmReconciled = true
      } else throw err
    }
  }
}
