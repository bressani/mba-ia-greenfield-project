import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoOriginalKey1795435209268 implements MigrationInterface {
  name = 'AddVideoOriginalKey1795435209268';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "videos" ADD COLUMN "original_key" text',
    );
    await queryRunner.query(
      `UPDATE "videos" SET "original_key" = 'videos/' || "id" || '/original'`,
    );
    await queryRunner.query(
      'ALTER TABLE "videos" ALTER COLUMN "original_key" SET NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "videos" DROP COLUMN "original_key"');
  }
}
