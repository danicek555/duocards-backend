-- CreateTable
CREATE TABLE "word_images" (
    "id" SERIAL NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "word_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "word_audio" (
    "id" SERIAL NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "word_audio_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- First, add the new columns (nullable for now)
ALTER TABLE "words" ADD COLUMN "imageId" INTEGER;
ALTER TABLE "words" ADD COLUMN "audioId" INTEGER;

-- Migrate existing data from imageUrl/audioUrl to new tables (if columns exist)
-- Note: This will only work if the old columns still exist
DO $$
DECLARE
    word_record RECORD;
    image_id INTEGER;
    audio_id INTEGER;
BEGIN
    -- Check if imageUrl column exists before migrating
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'words' AND column_name = 'imageUrl'
    ) THEN
        FOR word_record IN SELECT id, "imageUrl", "audioUrl" FROM words WHERE "imageUrl" IS NOT NULL OR "audioUrl" IS NOT NULL
        LOOP
            -- Migrate image
            IF word_record."imageUrl" IS NOT NULL AND word_record."imageUrl" != '' THEN
                INSERT INTO word_images ("dataUrl", "mimeType", "createdAt", "updatedAt")
                VALUES (word_record."imageUrl", 'image/png', NOW(), NOW())
                RETURNING id INTO image_id;
                
                UPDATE words SET "imageId" = image_id WHERE id = word_record.id;
            END IF;
            
            -- Migrate audio
            IF word_record."audioUrl" IS NOT NULL AND word_record."audioUrl" != '' THEN
                INSERT INTO word_audio ("dataUrl", "mimeType", "createdAt", "updatedAt")
                VALUES (word_record."audioUrl", 'audio/mpeg', NOW(), NOW())
                RETURNING id INTO audio_id;
                
                UPDATE words SET "audioId" = audio_id WHERE id = word_record.id;
            END IF;
        END LOOP;
    END IF;
END $$;

-- Add unique constraints
CREATE UNIQUE INDEX "words_imageId_key" ON "words"("imageId");
CREATE UNIQUE INDEX "words_audioId_key" ON "words"("audioId");

-- AddForeignKey
ALTER TABLE "words" ADD CONSTRAINT "words_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "word_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "words" ADD CONSTRAINT "words_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "word_audio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop old columns if they exist (commented out for safety - uncomment after verifying migration)
-- ALTER TABLE "words" DROP COLUMN IF EXISTS "imageUrl";
-- ALTER TABLE "words" DROP COLUMN IF EXISTS "audioUrl";







