import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** A custom default must already exist; never recreate a missing custom location. */
export async function validateProjectDirectory(directory: string) {
  if (!path.isAbsolute(directory) || directory.includes('\0')) throw new Error('PROJECT_DIRECTORY_REJECTED');
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) throw new Error('PROJECT_DIRECTORY_REJECTED');
  await access(canonical, constants.R_OK | constants.W_OK);
  return canonical;
}
