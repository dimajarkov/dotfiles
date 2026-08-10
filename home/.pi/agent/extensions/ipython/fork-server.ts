export class ForkServerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkServerUnavailable";
  }
}

export function isForkServerEnabled(): boolean {
  return false;
}

export async function forkKernel(
  _python: string,
  _spawn: {
    connectionPath: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<number> {
  throw new ForkServerUnavailable("The standalone Pi extension uses direct kernel spawning");
}
