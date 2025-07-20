import { TelegramClient } from "telegram";
import { Api } from "telegram";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { db } from "../database";
import { messageMedia, messages } from "../database/schema";
import { eq } from "drizzle-orm";
import * as sharp from "sharp";
import * as ffmpeg from "fluent-ffmpeg";

export interface MediaFile {
  id: string;
  type: "photo" | "video" | "audio" | "voice" | "document";
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  originalFileId: string;
  caption?: string;
}

export class TelegramMediaService {
  private mediaDir: string;

  constructor(mediaDir = "./media") {
    this.mediaDir = mediaDir;
    this.ensureMediaDir();
  }

  private async ensureMediaDir() {
    try {
      await fs.access(this.mediaDir);
    } catch {
      await fs.mkdir(this.mediaDir, { recursive: true });
    }
  }

  /**
   * Генерує timestamp для назви файлу у форматі YYYYMMDD_HHMMSS
   */
  private generateTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");

    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  async downloadAndCompressMedia(
    client: TelegramClient,
    message: Api.Message,
    messageDbId: string,
  ): Promise<string | null> {
    try {
      if (!message.media) return null;

      // Спочатку завантажуємо оригінальний файл
      const originalPath = await this.downloadAndSaveMedia(
        client,
        message,
        messageDbId,
      );
      if (!originalPath) return null;

      // Визначаємо тип медіа та стискаємо
      const media = message.media;
      if (media instanceof Api.MessageMediaDocument) {
        const doc = media.document;
        if (doc instanceof Api.Document && doc.mimeType) {
          if (doc.mimeType.startsWith("image/")) {
            return await this.compressImage(originalPath, messageDbId);
          } else if (doc.mimeType.startsWith("video/")) {
            return await this.compressVideo(originalPath, messageDbId);
          }
        }
      } else if (media instanceof Api.MessageMediaPhoto) {
        return await this.compressImage(originalPath, messageDbId);
      }

      // Якщо тип не підтримується для стискання, повертаємо оригінал
      return originalPath;
    } catch (error) {
      console.error("Error downloading and compressing media:", error);
      return null;
    }
  }

  /**
   * Стискає зображення
   */
  private async compressImage(
    originalPath: string,
    messageDbId: string,
  ): Promise<string | null> {
    try {
      const parsedPath = path.parse(originalPath);
      const timestamp = this.generateTimestamp();
      const compressedPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}_${timestamp}_compressed.jpg`,
      );

      // Стискаємо зображення з якістю 70% та обмежуємо розмір до 2048x2048
      //@ts-ignore
      await sharp(originalPath)
        .resize(2048, 2048, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 70,
          progressive: true,
        })
        .toFile(compressedPath);

      // Перевіряємо розмір стисненого файлу
      const compressedStats = await fs.stat(compressedPath);
      const originalStats = await fs.stat(originalPath);

      console.log(
        `📸 Зображення стиснуто: ${originalStats.size} → ${compressedStats.size} bytes`,
      );

      // Якщо стискання успішне, видаляємо оригінал
      await fs.unlink(originalPath);

      // Оновлюємо запис в БД
      await this.updateMediaPath(messageDbId, compressedPath);

      return compressedPath;
    } catch (error) {
      console.error("Error compressing image:", error);
      return originalPath; // Повертаємо оригінал у разі помилки
    }
  }

  /**
   * Стискає відео
   */
  private async compressVideo(
    originalPath: string,
    messageDbId: string,
  ): Promise<string | null> {
    try {
      const parsedPath = path.parse(originalPath);
      const timestamp = this.generateTimestamp();
      const compressedPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}_${timestamp}_compressed.mp4`,
      );

      return new Promise((resolve, reject) => {
        //@ts-ignore
        ffmpeg(originalPath)
          .outputOptions([
            "-c:v libx264", // Відео кодек
            "-crf 28", // Константа якості (18-28, більше = менший файл)
            "-preset fast", // Швидкість кодування
            "-c:a aac", // Аудіо кодек
            "-b:a 128k", // Бітрейт аудіо
            "-movflags +faststart", // Оптимізація для веб
          ])
          .videoFilters([
            "scale=1280:720:force_original_aspect_ratio=decrease", // Зменшуємо розмір
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2", // Додаємо відступи
          ])
          .output(compressedPath)
          .on("end", async () => {
            try {
              // Перевіряємо розмір стисненого файлу
              const compressedStats = await fs.stat(compressedPath);
              const originalStats = await fs.stat(originalPath);

              console.log(
                `🎥 Відео стиснуто: ${originalStats.size} → ${compressedStats.size} bytes`,
              );

              // Видаляємо оригінал
              await fs.unlink(originalPath);

              // Оновлюємо запис в БД
              await this.updateMediaPath(messageDbId, compressedPath);

              resolve(compressedPath);
            } catch (error) {
              console.error("Error updating compressed video:", error);
              resolve(originalPath);
            }
          })
          .on("error", (error: any) => {
            console.error("Error compressing video:", error);
            resolve(originalPath);
          })
          .run();
      });
    } catch (error) {
      console.error("Error in compressVideo:", error);
      return originalPath;
    }
  }

  /**
   * Оновлює шлях до медіа в БД
   */
  private async updateMediaPath(
    messageDbId: string,
    newPath: string,
  ): Promise<void> {
    try {
      await db
        .update(messageMedia)
        .set({ localFilePath: newPath })
        .where(eq(messageMedia.messageId, messageDbId));
    } catch (error) {
      console.error("Error updating media path in DB:", error);
    }
  }

  /**
   * Перевіряє розмір файлу після стискання
   */
  private async checkCompressedSize(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      const maxSize = 45 * 1024 * 1024; // 45 MB
      return stats.size <= maxSize;
    } catch {
      return false;
    }
  }

  async downloadAndSaveMedia(
    client: TelegramClient,
    message: Api.Message,
    messageDbId: string,
  ): Promise<string | null> {
    if (!message.media) return null;

    try {
      let mediaInfo: any = {};
      let fileExtension = "";
      let fileName = "";
      const timestamp = this.generateTimestamp(); // Генеруємо timestamp

      if (message.media instanceof Api.MessageMediaPhoto) {
        const photo = message.media.photo;
        if (photo instanceof Api.Photo) {
          mediaInfo = {
            type: "photo",
            fileId: photo.id.toString(),
            fileUniqueId: photo.id.toString(),
          };
          fileExtension = ".jpg";
          fileName = `photo_${photo.id}_${timestamp}${fileExtension}`;
        }
      } else if (message.media instanceof Api.MessageMediaDocument) {
        const doc = message.media.document;
        if (doc instanceof Api.Document) {
          let type = "document";
          if (doc.mimeType) {
            if (doc.mimeType.startsWith("video/")) type = "video";
            else if (doc.mimeType.startsWith("audio/")) type = "audio";
            else if (doc.mimeType === "audio/ogg") type = "voice";
          }

          const fileNameAttr = doc.attributes?.find(
            (attr) => attr.className === "DocumentAttributeFilename",
          ) as any;

          const originalFileName = fileNameAttr?.fileName || `file_${doc.id}`;
          fileExtension =
            path.extname(originalFileName) ||
            this.getExtensionByMimeType(doc.mimeType);

          // Додаємо timestamp до назви файлу
          fileName = `${type}_${doc.id}_${timestamp}${fileExtension}`;

          mediaInfo = {
            type,
            fileId: doc.id.toString(),
            fileUniqueId: doc.accessHash?.toString() || "",
            mimeType: doc.mimeType,
            originalFileName,
          };
        }
      }

      if (!mediaInfo.fileId) return null;

      const filePath = path.join(this.mediaDir, fileName);
      const buffer = (await client.downloadMedia(message.media, {
        outputFile: undefined,
      })) as Buffer;

      if (!buffer) return null;

      await fs.writeFile(filePath, buffer);
      const stats = await fs.stat(filePath);

      await db.insert(messageMedia).values({
        messageId: messageDbId,
        type: mediaInfo.type,
        fileId: mediaInfo.fileId,
        fileUniqueId: mediaInfo.fileUniqueId,
        caption: message.message || "",
        localFilePath: filePath,
        fileName: fileName,
        fileSize: stats.size,
        mimeType: mediaInfo.mimeType,
        originalFileName: mediaInfo.originalFileName,
      });

      console.log(`📁 Медіафайл збережено: ${fileName} (${stats.size} bytes)`);
      return filePath;
    } catch (error) {
      console.error("Помилка при завантаженні медіафайлу:", error);
      return null;
    }
  }

  async deleteMediaByMessageId(messageId: string): Promise<void> {
    try {
      // Получаем все медиафайлы для данного сообщения
      const mediaRecords = await db
        .select()
        .from(messageMedia)
        .where(eq(messageMedia.messageId, messageId));

      if (mediaRecords.length === 0) {
        return;
      }

      for (const record of mediaRecords) {
        if (record.localFilePath) {
          try {
            await fs.unlink(record.localFilePath);
            console.log(`🗑️ Видалено медіафайл: ${record.fileName}`);
          } catch (error) {
            console.warn(
              `⚠️ Не вдалося видалити файл: ${record.localFilePath}`,
              error,
            );
          }
        }
      }

      const deletedCount = await db
        .delete(messageMedia)
        .where(eq(messageMedia.messageId, messageId));

      console.log(
        `🗑️ Видалено ${mediaRecords.length} медіафайлів для повідомлення ${messageId}`,
      );
    } catch (error) {
      console.error("Помилка при видаленні медіафайлів:", error);
      throw error;
    }
  }

  async deleteMediaById(mediaId: string): Promise<boolean> {
    try {
      const mediaRecord = await db
        .select()
        .from(messageMedia)
        .where(eq(messageMedia.id, mediaId))
        .limit(1);

      if (mediaRecord.length === 0) {
        console.log(`🔍 Медіафайл ${mediaId} не знайдено`);
        return false;
      }

      const record = mediaRecord[0];

      if (record.localFilePath) {
        try {
          await fs.unlink(record.localFilePath);
          console.log(`🗑️ Видалено медіафайл: ${record.fileName}`);
        } catch (error) {
          console.warn(
            `⚠️ Не вдалося видалити файл: ${record.localFilePath}`,
            error,
          );
        }
      }

      await db.delete(messageMedia).where(eq(messageMedia.id, mediaId));

      console.log(`🗑️ Медіафайл ${mediaId} видалено з бази даних`);
      return true;
    } catch (error) {
      console.error("Помилка при видаленні медіафайлу:", error);
      return false;
    }
  }

  async getMediaByMessageId(messageId: string): Promise<MediaFile[]> {
    const mediaRecords = await db
      .select()
      .from(messageMedia)
      .where(eq(messageMedia.messageId, messageId));

    return mediaRecords.map((record) => ({
      id: record.id,
      type: record.type as any,
      fileName: record.fileName || "",
      filePath: record.localFilePath || "",
      fileSize: record.fileSize || 0,
      mimeType: record.mimeType || undefined,
      originalFileId: record.fileId,
      caption: record.caption || undefined,
    }));
  }

  async getMediaBuffer(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mediaInfo: MediaFile } | null> {
    const mediaRecord = await db
      .select()
      .from(messageMedia)
      .where(eq(messageMedia.id, mediaId))
      .limit(1);

    if (mediaRecord.length === 0 || !mediaRecord[0].localFilePath) {
      return null;
    }

    try {
      const buffer = await fs.readFile(mediaRecord[0].localFilePath);
      const mediaInfo: MediaFile = {
        id: mediaRecord[0].id,
        type: mediaRecord[0].type as any,
        fileName: mediaRecord[0].fileName || "",
        filePath: mediaRecord[0].localFilePath,
        fileSize: mediaRecord[0].fileSize || 0,
        mimeType: mediaRecord[0].mimeType || undefined,
        originalFileId: mediaRecord[0].fileId,
        caption: mediaRecord[0].caption || undefined,
      };

      return { buffer, mediaInfo };
    } catch (error) {
      console.error("Ошибка при чтении файла:", error);
      return null;
    }
  }

  async duplicateMedia(
    mediaId: string,
    newCaption?: string,
  ): Promise<string | null> {
    const original = await this.getMediaBuffer(mediaId);
    if (!original) return null;

    const { buffer, mediaInfo } = original;
    const hash = crypto.createHash("md5").update(buffer).digest("hex");
    const timestamp = this.generateTimestamp();
    const newFileName = `copy_${hash}_${timestamp}_${mediaInfo.fileName}`;
    const newFilePath = path.join(this.mediaDir, newFileName);

    try {
      await fs.writeFile(newFilePath, buffer);

      const [newRecord] = await db
        .insert(messageMedia)
        .values({
          messageId: "",
          type: mediaInfo.type,
          fileId: `copy_${mediaInfo.originalFileId}`,
          fileUniqueId: hash,
          caption: newCaption || mediaInfo.caption || "",
          localFilePath: newFilePath,
          fileName: newFileName,
          fileSize: mediaInfo.fileSize,
          mimeType: mediaInfo.mimeType,
          originalFileName: mediaInfo.fileName,
        })
        .returning();

      return newRecord.id;
    } catch (error) {
      console.error("Ошибка при дублировании файла:", error);
      return null;
    }
  }

  async getMediaList(filters?: {
    type?: string;
    channelId?: string;
    limit?: number;
    offset?: number;
  }): Promise<MediaFile[]> {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    let query = db
      .select({
        id: messageMedia.id,
        type: messageMedia.type,
        fileName: messageMedia.fileName,
        localFilePath: messageMedia.localFilePath,
        fileSize: messageMedia.fileSize,
        mimeType: messageMedia.mimeType,
        fileId: messageMedia.fileId,
        caption: messageMedia.caption,
        channelId: messages.channelId,
      })
      .from(messageMedia)
      .leftJoin(messages, eq(messageMedia.messageId, messages.id))
      .limit(limit)
      .offset(offset);

    if (filters?.type) {
      query = query.where(eq(messageMedia.type, filters.type)) as any;
    }
    if (filters?.channelId) {
      query = query.where(eq(messages.channelId, filters.channelId)) as any;
    }

    const results = await query;

    return results.map((record) => ({
      id: record.id,
      type: record.type as any,
      fileName: record.fileName || "",
      filePath: record.localFilePath || "",
      fileSize: record.fileSize || 0,
      mimeType: record.mimeType || undefined,
      originalFileId: record.fileId,
      caption: record.caption || undefined,
    }));
  }

  private getExtensionByMimeType(mimeType?: string): string {
    if (!mimeType) return "";

    const mimeMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/avi": ".avi",
      "video/mkv": ".mkv",
      "audio/mp3": ".mp3",
      "audio/ogg": ".ogg",
      "audio/wav": ".wav",
      "application/pdf": ".pdf",
      "text/plain": ".txt",
    };

    return mimeMap[mimeType] || "";
  }

  async cleanupOldFiles(olderThanDays: number = 30): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    try {
      const oldRecords = await db
        .select()
        .from(messageMedia)
        .leftJoin(messages, eq(messageMedia.messageId, messages.id))
        .where(`messages.date < '${cutoffDate.toISOString()}'` as any);

      for (const record of oldRecords) {
        if (record.message_media.localFilePath) {
          try {
            await fs.unlink(record.message_media.localFilePath);
            console.log(
              `🗑️ Удален старый файл: ${record.message_media.fileName}`,
            );
          } catch (error) {
            console.warn(
              `Не удалось удалить файл: ${record.message_media.localFilePath}`,
            );
          }
        }
      }
    } catch (error) {
      console.error("Ошибка при очистке старых файлов:", error);
    }
  }

  async bulkDeleteMediaByMessageIds(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    try {
      const mediaRecords = await db
        .select()
        .from(messageMedia)
        .where(eq(messageMedia.messageId, messageIds[0]));
      for (const messageId of messageIds) {
        await this.deleteMediaByMessageId(messageId);
      }

      console.log(
        `🗑️ Масово видалено медіафайли для ${messageIds.length} повідомлень`,
      );
    } catch (error) {
      console.error("Помилка при масовому видаленні медіафайлів:", error);
      throw error;
    }
  }
}
