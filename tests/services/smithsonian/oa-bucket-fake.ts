/**
 * @fileoverview In-memory stand-in for the `smithsonian-open-access` S3 bucket, served through a
 * `fetch` stub: ListObjectsV2 pages in the bucket's own XML shape and shard GETs, with every
 * request recorded. Any other URL rejects as an unmocked fetch. Also opens a mirror over a
 * fresh temporary store.
 * @module tests/services/smithsonian/oa-bucket-fake
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMirror, type MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { vi } from 'vitest';
import { createOaSync, OA_BUCKET_URL } from '@/services/smithsonian/oa-ingest.js';
import { OaMirror, oaMirrorStore } from '@/services/smithsonian/oa-mirror.js';

const DEFAULT_LAST_MODIFIED = '2026-10-26T07:25:06.000Z';

/** One object in the fake bucket. */
export interface FakeObject {
  body: string;
  /** Listed ETag; defaults to the body's MD5. */
  etag?: string;
  lastModified: string;
  /** Status a GET answers with; defaults to 200. */
  status?: number;
}

/** A request the fake answered, in order. */
export interface FakeRequest {
  url: URL;
  userAgent: string | null;
}

const BUCKET_HOST = new URL(OA_BUCKET_URL).hostname;

export const md5 = (text: string) => createHash('md5').update(text).digest('hex');

export class FakeBucket {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeRequest[] = [];
  /** Keys per listing page; S3 uses 1,000, a small value exercises continuation. */
  pageSize = 3;

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== BUCKET_HOST) throw new Error('unmocked fetch');
    init?.signal?.throwIfAborted();
    this.requests.push({ url, userAgent: new Headers(init?.headers).get('user-agent') });
    if (url.pathname === '/' && url.searchParams.get('list-type') === '2') {
      return new Response(this.listPage(url), { status: 200 });
    }
    const object = this.objects.get(decodeURIComponent(url.pathname.slice(1)));
    if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(Buffer.from(object.body), { status: object.status ?? 200 });
  });

  put(key: string, lines: readonly string[], lastModified = DEFAULT_LAST_MODIFIED): void {
    const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    this.objects.set(key, { body, lastModified });
  }

  /** Requests other than listings: the shard downloads. */
  downloads(): string[] {
    return this.requests.filter((r) => r.url.pathname !== '/').map((r) => r.url.pathname.slice(1));
  }

  listings(): number {
    return this.requests.filter((r) => r.url.pathname === '/').length;
  }

  private listPage(url: URL): string {
    const prefix = url.searchParams.get('prefix') ?? '';
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const token = url.searchParams.get('continuation-token');
    // Tokens carry the characters real ones do (`+`, `/`, `=`), so query encoding is exercised.
    const offset = token ? Number(Buffer.from(token.replace('+/', ''), 'base64').toString()) : 0;
    const page = keys.slice(offset, offset + this.pageSize);
    const truncated = offset + this.pageSize < keys.length;
    const next = `+/${Buffer.from(String(offset + this.pageSize)).toString('base64')}`;
    const contents = page
      .map((key) => {
        const object = this.objects.get(key) as FakeObject;
        const etag = object.etag ?? md5(object.body);
        return `<Contents><Key>${key}</Key><LastModified>${object.lastModified}</LastModified><ETag>&quot;${etag}&quot;</ETag><ChecksumAlgorithm>CRC64NVME</ChecksumAlgorithm><ChecksumType>FULL_OBJECT</ChecksumType><Size>${Buffer.byteLength(object.body)}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>smithsonian-open-access</Name><Prefix>${prefix}</Prefix>${truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}<KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}</ListBucketResult>`;
  }
}

/** A mirror over a fresh store in its own temporary directory. */
export interface TestMirror {
  close(): Promise<void>;
  mirror: ReturnType<typeof defineMirror>;
  path: string;
  reader: OaMirror;
  store: MirrorStore;
}

export function openTestMirror(): TestMirror {
  const dir = mkdtempSync(join(tmpdir(), 'oa-mirror-test-'));
  const path = join(dir, 'mirror.db');
  const store = oaMirrorStore(path);
  const mirror = defineMirror({ name: 'oa-test', store, logger: {}, sync: createOaSync(store) });
  return {
    path,
    store,
    mirror,
    reader: new OaMirror(store),
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal `edanmdm` bulk line; `fields` is merged over its top level. */
export function bulkLine(id: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `ld1-${id}`,
    url: `edanmdm:${id}`,
    type: 'edanmdm',
    unitCode: 'TST',
    title: `Object ${id}`,
    hash: md5(id),
    lastTimeUpdated: 1_761_000_000,
    content: {
      descriptiveNonRepeating: { unit_code: 'TST', record_ID: id, data_source: 'Test Unit' },
      indexedStructured: { topic: ['Testing'] },
    },
    ...fields,
  });
}
