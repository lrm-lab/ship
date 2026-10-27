-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "release_channel" AS ENUM ('dev', 'stable');

-- CreateTable
CREATE TABLE "orgs" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "app" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" "release_channel" NOT NULL,
    "created_by_agent_id" TEXT NOT NULL,
    "updated_by_agent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_notes" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orgs_issuer_workspace_id_key" ON "orgs"("issuer", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "releases_org_id_app_version_key" ON "releases"("org_id", "app", "version");

-- CreateIndex
CREATE UNIQUE INDEX "release_notes_release_id_locale_key" ON "release_notes"("release_id", "locale");

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notes" ADD CONSTRAINT "release_notes_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
