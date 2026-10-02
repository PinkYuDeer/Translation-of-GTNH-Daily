import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { PtHttpError } from './pt-client.ts'

/** Only denied project access is optional; invalid credentials and outages remain fatal. */
export function isSourceAccessDenied(error: unknown): error is PtHttpError {
  return error instanceof PtHttpError && error.status === 403
}

/** Publish a complete snapshot, never a partial download or a previous run's source. */
export async function pullReviewedSource(
  outRoot: string,
  pull: (stagingRoot: string) => Promise<void>,
  options: { required: boolean, onUnavailable: (error: PtHttpError) => Promise<void> },
): Promise<boolean> {
  await mkdir(dirname(outRoot), { recursive: true })
  const stagingRoot = await mkdtemp(`${outRoot}.staging-`)
  try {
    await pull(stagingRoot)
    await rm(outRoot, { recursive: true, force: true })
    await rename(stagingRoot, outRoot)
    return true
  }
  catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (!isSourceAccessDenied(error) || options.required)
      throw error
    await rm(outRoot, { recursive: true, force: true })
    await mkdir(outRoot, { recursive: true })
    await options.onUnavailable(error)
    return false
  }
}
