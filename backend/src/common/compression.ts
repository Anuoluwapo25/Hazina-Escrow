/**
 * Response compression middleware for Express.
 *
 * Supports brotli (br), gzip, and deflate via Node's built-in `zlib` module —
 * no external dependencies required.
 *
 * Behaviour:
 *  - Negotiates encoding from the client's `Accept-Encoding` header.
 *  - Prefers brotli > gzip > deflate (best compression ratio first).
 *  - Only compresses responses whose `Content-Type` matches compressible MIME
 *    types (JSON, text, JS, XML, SVG …).
 *  - Skips responses smaller than `threshold` bytes (default 1 KB).
 *  - Sets `Content-Encoding`, removes `Content-Length` (now invalid after
 *    compression), and adds `Vary: Accept-Encoding`.
 */

import { logger } from '../lib/logger';

import zlib from 'zlib';
import { Request, Response, NextFunction } from 'express';

// ── Types ─────────────────────────────────────────────────────────────────────

type Encoding = 'br' | 'gzip' | 'deflate';

export interface CompressionOptions {
  /** Minimum response size in bytes to compress. Default: 1024 (1 KB). */
  threshold?: number;
  /**
   * Brotli quality level 0–11. Higher = better compression, slower CPU.
   * Default: 4 (good balance for dynamic API responses).
   */
  brotliQuality?: number;
  /**
   * Gzip compression level 1–9.
   * Default: zlib.constants.Z_DEFAULT_COMPRESSION (usually 6).
   */
  gzipLevel?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** MIME types that benefit from text compression. */
const COMPRESSIBLE_RE =
  /\b(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded)|image\/svg\+xml)/i;

function isCompressible(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return COMPRESSIBLE_RE.test(contentType);
}

/**
 * Pick the best encoding the client advertises.
 * Returns null if the client accepts no supported encoding.
 */
/** Tiebreak priority: higher = preferred when q-values are equal. */
const ENCODING_PRIORITY: Record<string, number> = { br: 3, gzip: 2, deflate: 1 };

function negotiateEncoding(acceptEncoding: string): Encoding | null {
  // Parse "br;q=1.0, gzip;q=0.8, deflate;q=0.6, *;q=0.1" style headers
  const directives = acceptEncoding
    .split(',')
    .map(part => {
      const [token, qPart] = part.trim().split(';');
      const q = qPart ? parseFloat(qPart.replace(/q\s*=\s*/, '')) : 1;
      return { token: (token ?? '').trim().toLowerCase(), q: isNaN(q) ? 1 : q };
    })
    .filter(d => d.q > 0)
    .sort(
      (a, b) => b.q - a.q || (ENCODING_PRIORITY[b.token] ?? 0) - (ENCODING_PRIORITY[a.token] ?? 0),
    );

  for (const { token } of directives) {
    if (token === 'br') {
      return 'br';
    }
    if (token === 'gzip') {
      return 'gzip';
    }
    if (token === 'deflate') {
      return 'deflate';
    }
  }
  return null;
}

function compress(
  buffer: Buffer,
  encoding: Encoding,
  opts: Required<CompressionOptions>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (encoding === 'br') {
      zlib.brotliCompress(
        buffer,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: opts.brotliQuality } },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    } else if (encoding === 'gzip') {
      zlib.gzip(buffer, { level: opts.gzipLevel }, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    } else {
      zlib.deflate(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    }
  });
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that transparently compresses responses.
 *
 * @example
 * ```ts
 * import { createCompressionMiddleware } from './common/compression';
 * app.use(createCompressionMiddleware());
 * ```
 */
export function createCompressionMiddleware(options: CompressionOptions = {}) {
  const opts: Required<CompressionOptions> = {
    threshold: options.threshold ?? 1024,
    brotliQuality: options.brotliQuality ?? 4,
    gzipLevel: options.gzipLevel ?? zlib.constants.Z_DEFAULT_COMPRESSION,
  };

  return function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Always advertise that we vary on Accept-Encoding
    res.setHeader('Vary', 'Accept-Encoding');

    const acceptEncoding = (req.headers['accept-encoding'] as string) || '';
    const encoding = negotiateEncoding(acceptEncoding);

    // No common encoding — pass through unmodified
    if (!encoding) {
      next();
      return;
    }

    // Intercept the response body by overriding res.write / res.end
    const chunks: Buffer[] = [];

    const originalWrite = res.write.bind(res) as typeof res.write;
    const originalEnd = res.end.bind(res) as typeof res.end;

    // Collect body chunks
    res.write = function (
      chunk: unknown,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      if (chunk) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                chunk as string,
                typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8',
              ),
        );
      }
      // Signal success to the caller without actually writing yet
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      callback?.();
      return true;
    };

    res.end = function (
      chunk?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): Response {
      if (chunk) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                chunk as string,
                typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8',
              ),
        );
      }

      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      const body = Buffer.concat(chunks);
      const contentType = res.getHeader('Content-Type') as string | undefined;

      // Skip compression when:
      //  • Content-Type is not compressible
      //  • Body is below the threshold
      //  • Response already has a Content-Encoding (e.g. static pre-compressed files)
      const shouldCompress =
        isCompressible(contentType) &&
        body.length >= opts.threshold &&
        !res.getHeader('Content-Encoding');

      if (!shouldCompress) {
        // Restore original methods and flush unmodified
        res.write = originalWrite;
        res.end = originalEnd;
        res.end(body, callback as () => void);
        return res;
      }

      compress(body, encoding, opts)
        .then(compressed => {
          res.setHeader('Content-Encoding', encoding);
          res.removeHeader('Content-Length'); // length changed after compression
          res.write = originalWrite;
          res.end = originalEnd;
          res.end(compressed, callback as () => void);
        })
        .catch((err: unknown) => {
          // Compression failed — fall back to uncompressed response
          logger.error({ err }, '[Compression] Failed to compress response');
          res.write = originalWrite;
          res.end = originalEnd;
          res.end(body, callback as () => void);
        });

      return res;
    };

    next();
  };
}
