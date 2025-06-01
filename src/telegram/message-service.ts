import { db } from "../database";
import { messages, messageMedia, allowedChannels } from "../database/schema";
import { eq, asc, desc, and, lt, gt, count } from "drizzle-orm";

export interface MessageWithMedia {
  id: string;
  messageId: number;
  channelId: string;
  text: string | null;
  date: Date;
  media: Array<{
    id: string;
    type: string;
    fileId: string;
    caption: string;
    localFilePath: string | null;
    fileName: string | null;
    fileSize: number | null;
    mimeType: string | null;
  }>;
}

export class MessageService {
  async getFirstMessageByChannelId(
    channelId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(asc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getLastMessageByChannelId(
    channelId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getNextMessage(
    channelId: string,
    currentDate: Date,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), gt(messages.date, currentDate)),
      )
      .orderBy(asc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getPreviousMessage(
    channelId: string,
    currentDate: Date,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), lt(messages.date, currentDate)),
      )
      .orderBy(desc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getMessageWithMedia(
    messageId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (message.length === 0) return null;

    const media = await db
      .select()
      .from(messageMedia)
      .where(eq(messageMedia.messageId, messageId));

    return {
      ...message[0],
      media: media.map((m) => ({
        id: m.id,
        type: m.type,
        fileId: m.fileId,
        caption: m.caption || "",
        localFilePath: m.localFilePath,
        fileName: m.fileName,
        fileSize: m.fileSize,
        mimeType: m.mimeType,
      })),
    };
  }

  async getMessageCount(channelId: string): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(messages)
      .where(eq(messages.channelId, channelId));

    return result[0]?.count || 0;
  }

  async getMessagePosition(
    channelId: string,
    messageDate: Date,
  ): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), lt(messages.date, messageDate)),
      );

    return (result[0]?.count || 0) + 1;
  }
}
