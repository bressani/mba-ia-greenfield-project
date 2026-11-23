import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1795435209266 implements MigrationInterface {
  name = 'CreateVideos1795435209266';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL, "url" character varying(64) NOT NULL, "channel_id" uuid NOT NULL, "filename" character varying(255) NOT NULL, "content_type" character varying(127) NOT NULL, "size_bytes" bigint NOT NULL, "upload_id" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "metadata" jsonb, "duration_seconds" double precision, "thumbnail_key" text, "failure_code" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_517d52e875e32f23347054eb285" UNIQUE ("url"), CONSTRAINT "CHK_videos_size_bytes" CHECK ("size_bytes" BETWEEN 1 AND 10000000000), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
