import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';
const mailpitOrigin = process.env.MAILPIT_ORIGIN ?? 'http://mailpit:8025';
const maxBytes = 10_000_000_000;
const partBytes = 64 * 1024 * 1024;
const sampleInterval = 200;

class CheckFailed extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

function rounded(value) {
  return Number(value.toFixed(2));
}

async function api(path, { method = 'GET', body, token, expected = 200 } = {}) {
  const response = await fetch(new URL(path, apiOrigin), {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  check(
    response.status === expected,
    `${method} ${path.split('?')[0]} HTTP ${response.status}, expected ${expected}`,
  );
  return text && JSON.parse(text);
}

async function login() {
  const email = `phase03-acceptance-${randomUUID()}@example.com`;
  const password = randomUUID();
  await api('/auth/register', {
    method: 'POST',
    body: { email, password },
    expected: 201,
  });
  const fetchMail = async (path) => {
    const res = await fetch(new URL(path, mailpitOrigin), {
      signal: AbortSignal.timeout(5_000),
    });
    check(res.ok, `Mailpit HTTP ${res.status}`);
    return res.json();
  };

  let confirmation;
  for (let attempt = 0; attempt < 20 && !confirmation; attempt++) {
    const inbox = await fetchMail('/api/v1/messages');
    confirmation = inbox.messages?.find((message) =>
      message.To.some(({ Address }) => Address === email),
    );
    if (!confirmation) await delay(250);
  }
  check(confirmation, 'Confirmation email did not arrive');
  const mail = await fetchMail(`/api/v1/message/${confirmation.ID}`);
  const token = mail.HTML.match(/confirm-email\?token=([^"<\s]+)/)?.[1];
  check(token, 'Confirmation email did not contain a token');
  await api(`/auth/confirm-email?token=${encodeURIComponent(token)}`, {
    expected: 204,
  });
  const credentials = await api('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  check(credentials.access_token, 'No access token issued');
  return credentials.access_token;
}

function makeMediaPrefix() {
  const dir = mkdtempSync(join(tmpdir(), 'streamtube-acceptance-'));
  try {
    const path = join(dir, 'synthetic.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:r=25:d=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path,
      ],
      { stdio: 'pipe', timeout: 30_000 },
    );
    const movie = readFileSync(path);
    // A legal ISO BMFF padding box fills the rest of the upload. Size 1 means
    // the actual box size (including its header) is an unsigned 64-bit value.
    const free = Buffer.alloc(16);
    free.writeUInt32BE(1);
    free.write('free', 4, 'ascii');
    free.writeBigUInt64BE(BigInt(maxBytes - movie.length), 8);
    return Buffer.concat([movie, free]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function probe(path = '/', token) {
  const started = performance.now();
  let status = 'connection-failed';
  try {
    const response = await fetch(new URL(path, apiOrigin), {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    status = String(response.status);
    await response.arrayBuffer();
  } catch {
    // Record failure status without including request information.
    status = 'connection-failed';
  }
  return { status, ms: performance.now() - started };
}

function reportSamples(stage, samples) {
  check(samples.length > 0, `No samples recorded for ${stage}`);
  const timings = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  const statuses = {};
  for (const { status } of samples)
    statuses[status] = (statuses[status] ?? 0) + 1;
  console.log(
    JSON.stringify({
      stage,
      requests: samples.length,
      statuses,
      p50Ms: rounded(timings[Math.ceil(timings.length / 2) - 1]),
      p95Ms: rounded(timings[Math.ceil(timings.length * 0.95) - 1]),
      maxMs: rounded(timings.at(-1)),
    }),
  );
  check(statuses['200'] === samples.length, `Non-200 response during ${stage}`);
}

async function baseline() {
  for (let index = 0; index < 5; index++) await probe();
  const samples = [];
  for (let index = 0; index < 100; index++) {
    const point = await probe();
    samples.push(point);
    await delay(Math.max(0, sampleInterval - point.ms));
  }
  reportSamples('baseline', samples);
}

function storageRequest(signedUrl, { method = 'GET', headers, body } = {}) {
  const signed = new URL(signedUrl);
  const origin = process.env.MEDIA_CONNECT_ORIGIN ?? signed.origin;
  const target = new URL(origin);
  target.pathname = signed.pathname;
  target.search = signed.search;
  const request = target.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const connection = request(
      target,
      {
        method,
        headers: {
          ...headers,
          host: signed.host,
          ...(body && { 'content-length': body.length }),
        },
        signal: AbortSignal.timeout(120_000),
      },
      resolve,
    );
    connection.once('error', reject);
    connection.end(body);
  });
}

async function storageBytes(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    check(size <= limit, 'Storage response larger than expected');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function uploadParts(path, token, prefix) {
  const emptyPart = Buffer.alloc(partBytes);
  const firstPart = Buffer.alloc(partBytes);
  prefix.copy(firstPart);
  const partsCount = Math.ceil(maxBytes / partBytes);
  let sentBytes = 0;

  for (let first = 1; first <= partsCount; first += 20) {
    const partNumbers = Array.from(
      { length: Math.min(20, partsCount - first + 1) },
      (_, index) => first + index,
    );
    const { parts } = await api(`${path}/upload/parts`, {
      method: 'POST',
      body: { partNumbers },
      token,
    });
    check(parts?.length === partNumbers.length, 'Incorrect signed part count');
    for (let index = 0; index < parts.length; index += 2) {
      await Promise.all(
        parts
          .slice(index, index + 2)
          .map(async ({ partNumber, sizeBytes, url }, batchIndex) => {
            check(
              partNumber === partNumbers[index + batchIndex],
              'Unexpected signed part number',
            );
            const size = Math.min(
              partBytes,
              maxBytes - (partNumber - 1) * partBytes,
            );
            check(sizeBytes === size, 'Signed part size differs from expected');
            const body = (partNumber === 1 ? firstPart : emptyPart).subarray(
              0,
              size,
            );
            const result = await storageRequest(url, { method: 'PUT', body });
            await storageBytes(result, 64 * 1024);
            check(
              result.statusCode === 200 && result.headers.etag,
              `Part ${partNumber} HTTP ${result.statusCode} or missing ETag`,
            );
            sentBytes += size;
          }),
      );
    }
  }
  check(sentBytes === maxBytes, 'Transferred bytes differ from limit');
  return { sentBytes, partsCount };
}

async function verifyRange(url, prefix) {
  const size = Math.min(512, prefix.length);
  const response = await storageRequest(url, {
    headers: { range: `bytes=0-${size - 1}` },
  });
  const range = response.headers['content-range'];
  if (
    response.statusCode !== 206 ||
    range !== `bytes 0-${size - 1}/${maxBytes}`
  ) {
    response.destroy();
    throw new CheckFailed('Playback did not confirm exact size via HTTP Range');
  }
  const received = await storageBytes(response, size);
  check(
    received.equals(prefix.subarray(0, size)),
    'Playback bytes differ from uploaded MP4',
  );
  return range;
}

async function acceptance() {
  const prefix = makeMediaPrefix();
  const token = await login();
  const uploadDetails = {
    title: 'Phase 03 acceptance',
    filename: 'phase03-acceptance.mp4',
    contentType: 'video/mp4',
  };
  await api('/videos', {
    method: 'POST',
    token,
    body: { ...uploadDetails, sizeBytes: maxBytes + 1 },
    expected: 400,
  });
  console.log(
    JSON.stringify({
      stage: 'size-limit',
      rejectedBytes: maxBytes + 1,
      status: 400,
    }),
  );
  const draft = await api('/videos', {
    method: 'POST',
    token,
    body: {
      ...uploadDetails,
      sizeBytes: maxBytes,
    },
    expected: 201,
  });
  const { id, status } = draft;
  check(
    id && status === 'draft' && draft.partSizeBytes === partBytes,
    'Expected a video draft with the agreed multipart layout',
  );
  const path = `/videos/${id}`;
  for (let index = 0; index < 5; index++) await probe();

  const rootSamples = [];
  const videoSamples = [];
  let running = true;
  let nextVideoProbe = 0;
  const sampleWhileUploading = async () => {
    while (running) {
      const pending = [probe().then((sample) => rootSamples.push(sample))];
      // This authenticated route shares the existing rate limit.
      if (performance.now() >= nextVideoProbe) {
        nextVideoProbe = performance.now() + 7_000;
        pending.push(
          probe(path, token).then((sample) => videoSamples.push(sample)),
        );
      }
      const before = performance.now();
      await Promise.all(pending);
      await delay(Math.max(0, sampleInterval - (performance.now() - before)));
    }
  };

  const started = performance.now();
  const sampling = sampleWhileUploading();
  let upload;
  try {
    upload = await uploadParts(path, token, prefix);
  } finally {
    running = false;
    await sampling;
    reportSamples('upload-get-root', rootSamples);
    reportSamples('upload-get-video', videoSamples);
  }
  const seconds = (performance.now() - started) / 1_000;
  console.log(
    JSON.stringify({
      stage: 'multipart',
      ...upload,
      seconds: rounded(seconds),
    }),
  );

  await api(`${path}/upload/complete`, {
    method: 'POST',
    token,
    expected: 202,
  });
  const deadline = performance.now() + 480_000;
  let video;
  while (performance.now() < deadline) {
    await delay(7_000);
    video = await api(path, { token });
    if (video.status === 'ready' || video.status === 'error') break;
  }
  check(video?.status === 'ready', 'Worker did not make the video ready');
  check(
    Number(video.sizeBytes) === maxBytes,
    'API did not confirm the expected size',
  );
  check(
    Number(video.durationSeconds) === 2 &&
      video.metadata?.videoCodec === 'h264' &&
      video.metadata?.width === 160 &&
      video.metadata?.height === 90,
    'Worker metadata differs from the synthetic video',
  );
  check(
    video.links?.playback && video.links.thumbnail && video.links.download,
    'No playback, thumbnail or download links',
  );
  const contentRange = await verifyRange(video.links.playback, prefix);
  const thumbnail = await storageRequest(video.links.thumbnail);
  if (
    thumbnail.statusCode !== 200 ||
    !thumbnail.headers['content-type']?.startsWith('image/')
  ) {
    thumbnail.destroy();
    throw new CheckFailed('Thumbnail is not available');
  }
  const thumbnailBytes = (await storageBytes(thumbnail, 5 * 1024 * 1024))
    .byteLength;
  check(thumbnailBytes > 0, 'Thumbnail is empty');
  console.log(
    JSON.stringify({
      stage: 'ready',
      videoId: id,
      status: video.status,
      confirmedBytes: Number(video.sizeBytes),
      durationSeconds: Number(video.durationSeconds),
      videoCodec: video.metadata.videoCodec,
      width: video.metadata.width,
      height: video.metadata.height,
      thumbnailBytes,
      playbackStatus: 206,
      contentRange,
    }),
  );
}

try {
  const mode = process.argv[2];
  if (mode === 'baseline') await baseline();
  else if (mode === 'upload') await acceptance();
  else
    throw new CheckFailed(
      'Usage: node test/video-10gb-acceptance.mjs baseline|upload',
    );
} catch (error) {
  // Transport and parse exceptions can carry signed URLs or response content.
  console.error(
    error instanceof CheckFailed
      ? error.message
      : `Acceptance failed (${error?.name ?? 'unknown error'})`,
  );
  process.exitCode = 1;
}
