import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoTitle1795435209267 implements MigrationInterface {
  name = 'AddVideoTitle1795435209267';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "videos" ADD COLUMN "title" character varying(255)',
    );
    await queryRunner.query('UPDATE "videos" SET "title" = "filename"');
    await queryRunner.query(
      'ALTER TABLE "videos" ALTER COLUMN "title" SET NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "videos" DROP COLUMN "title"');
  }
}
