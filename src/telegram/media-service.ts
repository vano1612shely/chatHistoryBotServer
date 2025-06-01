import { TelegramClient } from "telegram";
import { Api } from "telegram";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { db } from "../database";
import { messageMedia, messages } from "../database/schema";
import { eq } from "drizzle-orm";

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

      if (message.media instanceof Api.MessageMediaPhoto) {
        const photo = message.media.photo;
        if (photo instanceof Api.Photo) {
          mediaInfo = {
            type: "photo",
            fileId: photo.id.toString(),
            fileUniqueId: photo.id.toString(),
          };
          fileExtension = ".jpg";
          fileName = `photo_${photo.id}${fileExtension}`;
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
          fileName = `${type}_${doc.id}${fileExtension}`;

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

      console.log(`📁 Медиафайл сохранен: ${fileName} (${stats.size} bytes)`);
      return filePath;
    } catch (error) {
      console.error("Ошибка при скачивании медиафайла:", error);
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
    const newFileName = `copy_${hash}_${mediaInfo.fileName}`;
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
