/**
 * compose.ts — the Docker half.
 *
 * Kept behind a thin wrapper so provision/status/reset all speak to the same
 * compose project, and so failures come back as messages a contributor can act
 * on (port already taken, Docker not running) rather than raw compose stderr.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { COMPOSE_FILE, COMPOSE_PROJECT, COMPOSE_SERVICE } from './config.ts';

const execFileAsync = promisify(execFile);

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerError';
  }
}

/**
 * Compose invocation, always against the same file and project name so
 * provision/status/reset/down can never act on different stacks.
 *
 * The port is NOT an argument here: docker-compose.devnet.yml reads it as
 * `${DEVNET_PORT:-8000}`, so it is passed through the child process environment
 * in `run()` instead.
 */
function composeArgs(...rest: string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, ...rest];
}

/** Verifies the Docker daemon is reachable before we try to use it. */
export async function assertDockerAvailable(): Promise<void> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}']);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    if (stderr.includes('Cannot connect to the Docker daemon')) {
      throw new DockerError(
        'Docker is installed but the daemon is not running. Start Docker Desktop ' +
          '(macOS/Windows) or `sudo systemctl start docker` (Linux), then retry.',
      );
    }
    throw new DockerError(
      'Docker is required to run the devnet but `docker info` failed. Install Docker ' +
        `Desktop from https://docs.docker.com/get-docker/ and retry.\n\n${stderr.slice(0, 400)}`,
    );
  }
}

/** True when something is already answering as a Stellar network on `horizonUrl`. */
export async function isDevnetRunning(horizonUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(horizonUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.network_passphrase === 'string';
  } catch {
    return false;
  }
}

/**
 * `docker compose up -d`, streaming output so the image pull is visible rather
 * than looking like a hang.
 */
export async function composeUp(
  cwd: string,
  port: number,
  log: (message: string) => void,
): Promise<void> {
  await assertDockerAvailable();
  log(`docker compose up -d ${COMPOSE_SERVICE} (port ${port})`);
  await run('docker', composeArgs('up', '-d', COMPOSE_SERVICE), cwd, port);
}

/** `docker compose down -v` — removes the container and any volumes with it. */
export async function composeDown(
  cwd: string,
  port: number,
  log: (message: string) => void,
): Promise<void> {
  await assertDockerAvailable();
  log('docker compose down -v --remove-orphans');
  await run('docker', composeArgs('down', '-v', '--remove-orphans'), cwd, port);
}

export interface ComposeStatus {
  running: boolean;
  raw: string;
}

export async function composeStatus(cwd: string, port: number): Promise<ComposeStatus> {
  await assertDockerAvailable();
  const { stdout } = await execFileAsync('docker', composeArgs('ps', '--format', 'json'), {
    cwd,
    env: { ...process.env, DEVNET_PORT: String(port) },
  });
  return { running: stdout.trim().length > 0 && stdout.includes(COMPOSE_SERVICE), raw: stdout };
}

function run(command: string, args: string[], cwd: string, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, DEVNET_PORT: String(port) },
    });
    child.on('error', err => rejectPromise(new DockerError(`${command} failed: ${err.message}`)));
    child.on('close', code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new DockerError(
          `\`${command} ${args.join(' ')}\` exited with code ${code}.\n` +
            `If the port is already in use, set DEVNET_PORT to a free port:\n` +
            `  DEVNET_PORT=8100 npm run devnet\n` +
            'See docs/DEVNET.md for troubleshooting.',
        ),
      );
    });
  });
}
