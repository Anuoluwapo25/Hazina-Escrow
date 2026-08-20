/**
 * cli.smoke.test.ts — spawns the real CLI entrypoint (via tsx, no build step)
 * as a child process against a local stub HTTP server, and checks exit codes
 * and output for the happy path, the mismatch path, and usage errors.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  computeLeafHash,
  computeReceiptHash,
  type ReceiptData,
} from './verify.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = path.join(packageRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageRoot, 'src', 'index.ts');

const payload = { data: [{ id: 1, name: 'Alice' }] };

function buildReceipt(): ReceiptData {
  const leaf = computeLeafHash(payload);
  const receiptHash = computeReceiptHash({
    leaf,
    datasetId: 'ds-cli-test',
    buyer: `G${'A'.repeat(55)}`,
    amount: 1,
    seller: `G${'B'.repeat(55)}`,
    deliveredAt: '2026-08-20T12:00:00.000Z',
  });
  return {
    id: 'rcpt_cli',
    datasetId: 'ds-cli-test',
    buyer: `G${'A'.repeat(55)}`,
    seller: `G${'B'.repeat(55)}`,
    amount: 1,
    paymentToken: 'USDC',
    txHash: 'tx-cli',
    leafHash: leaf.toString('hex'),
    receiptHash: receiptHash.toString('hex'),
    anchorMode: 'direct',
    anchorStatus: 'NOT_ANCHORED_YET',
    deliveredAt: '2026-08-20T12:00:00.000Z',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
  };
}

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/v1/receipts/rcpt_cli')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, receipt: buildReceipt() }));
      return;
    }
    if (url.startsWith('/api/v1/receipts/rcpt_tampered')) {
      const receipt = buildReceipt();
      receipt.receiptHash = '00'.repeat(32);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, receipt }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Receipt not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address && typeof address === 'object') {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [tsx, entry, ...args], {
      cwd: packageRoot,
      env: { ...process.env, HAZINA_API_URL: baseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe('hazina-verify CLI', () => {
  it('verifies a matching receipt (exit 0)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'hazina-verify-'));
    const payloadPath = path.join(tmp, 'payload.json');
    await writeFile(payloadPath, JSON.stringify(payload));

    const { code, stdout, stderr } = await runCli([
      'rcpt_cli',
      '--payload',
      payloadPath,
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('Receipt verified');
    expect(stdout).toContain('rcpt_cli');
  });

  it('fails on a tampered receipt hash (exit 1)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'hazina-verify-'));
    const payloadPath = path.join(tmp, 'payload.json');
    await writeFile(payloadPath, JSON.stringify(payload));

    const { code, stdout } = await runCli([
      'rcpt_tampered',
      '--payload',
      payloadPath,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain('FAILED verification');
  });

  it('exits 2 on usage errors', async () => {
    const { code } = await runCli([]);
    expect(code).toBe(2);
  });

  it('exits 2 when the receipt does not exist', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'hazina-verify-'));
    const payloadPath = path.join(tmp, 'payload.json');
    await writeFile(payloadPath, JSON.stringify(payload));

    const { code, stderr } = await runCli([
      'rcpt_missing',
      '--payload',
      payloadPath,
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain('404');
  });

  it('supports --leaf-hash verification', async () => {
    const leaf = computeLeafHash(payload).toString('hex');
    const { code, stdout } = await runCli(['rcpt_cli', '--leaf-hash', leaf]);
    expect(code).toBe(0);
    expect(stdout).toContain('Receipt verified');
  });
});