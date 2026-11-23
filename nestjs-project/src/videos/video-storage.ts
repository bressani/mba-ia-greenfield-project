import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

const PUBLIC_URL_SECONDS = 15 * 60;

export interface UploadedPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

@Injectable()
export class VideoStorage implements OnApplicationShutdown {
  private readonly bucket = process.env.S3_BUCKET ?? 'streamtube-videos';
  private readonly internal = this.client(
    process.env.S3_ENDPOINT ?? 'http://minio:9000',
  );
  private readonly publicSigner = this.client(
    process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  );
  private bucketReady?: Promise<void>;

  onApplicationShutdown(): void {
    this.internal.destroy();
    this.publicSigner.destroy();
  }

  async createUpload(
    originalKey: string,
    contentType: string,
  ): Promise<string> {
    this.bucketReady ??= this.createBucketIfMissing().catch(
      (error: unknown) => {
        this.bucketReady = undefined;
        throw error;
      },
    );
    await this.bucketReady;

    const result = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: originalKey,
        ContentType: /^(video|audio)\/[a-z0-9][a-z0-9._+-]*$/i.test(contentType)
          ? contentType
          : 'application/octet-stream',
      }),
    );
    if (!result.UploadId) {
      throw new Error('Object storage omitted the multipart upload ID');
    }
    return result.UploadId;
  }

  async abortUpload(originalKey: string, uploadId: string): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: originalKey,
        UploadId: uploadId,
      }),
    );
  }

  async listParts(
    originalKey: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.internal.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: originalKey,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        const { PartNumber, Size, ETag } = part;
        if (
          PartNumber === undefined ||
          Size === undefined ||
          ETag === undefined
        ) {
          throw new Error('Object storage returned incomplete part metadata');
        }
        parts.push({ partNumber: PartNumber, sizeBytes: Size, etag: ETag });
      }
      if (page.IsTruncated && !page.NextPartNumberMarker) {
        throw new Error('Object storage omitted the next part number marker');
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  signPart(
    originalKey: string,
    uploadId: string,
    partNumber: number,
    sizeBytes: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicSigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: originalKey,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: sizeBytes,
      }),
      {
        expiresIn: PUBLIC_URL_SECONDS,
        signableHeaders: new Set(['content-length']),
      },
    );
  }

  async completeUpload(
    originalKey: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: originalKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
    );
  }

  async originalSize(originalKey: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.internal.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: originalKey,
        }),
      );
      if (ContentLength === undefined) {
        throw new Error('Object storage omitted the object length');
      }
      return ContentLength;
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async openOriginal(originalKey: string): Promise<Readable> {
    const { Body } = await this.internal.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: originalKey,
      }),
    );
    if (!(Body instanceof Readable)) {
      throw new Error('Object storage did not return a readable body');
    }
    return Body;
  }

  async putThumbnail(videoId: string, body: Uint8Array): Promise<string> {
    const key = `videos/${videoId}/thumbnail.jpg`;
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: 'image/jpeg',
        Body: body,
      }),
    );
    return key;
  }

  async signLinks(originalKey: string, filename: string, thumbnailKey: string) {
    const [thumbnail, playback, download] = await Promise.all([
      this.signRead(thumbnailKey),
      this.signRead(originalKey),
      this.signRead(originalKey, downloadDisposition(filename)),
    ]);
    return { thumbnail, playback, download };
  }

  private signRead(key: string, disposition?: string): Promise<string> {
    return getSignedUrl(
      this.publicSigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: PUBLIC_URL_SECONDS },
    );
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (
        !(error instanceof S3ServiceException) ||
        error.$metadata.httpStatusCode !== 404
      ) {
        throw error;
      }
    }

    try {
      await this.internal.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
    } catch (error) {
      if (
        !(error instanceof S3ServiceException) ||
        !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)
      ) {
        throw error;
      }
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    }
  }

  private client(endpoint: string): S3Client {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    return new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}

function downloadDisposition(filename: string): string {
  const safeName = Buffer.from(filename, 'utf8')
    .toString('utf8')
    .replace(/[\\/\p{Cc}]/gu, '_');
  const fallback = safeName.replace(/[^A-Za-z0-9_. -]/g, '_');
  const encoded = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
