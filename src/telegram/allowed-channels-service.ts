// allowed-channels-service.ts
import { db } from "../database";
import { allowedChannels } from "../database/schema";
import { eq, desc } from "drizzle-orm";

class AllowedChannelsService {
  private allowedChannelIdsSet = new Set<string>();
  private initialized = false;

  constructor() {
    this.initializeCache().catch((err) => {
      console.error("Failed to initialize allowed channels cache:", err);
    });
  }

  public async initializeCache(): Promise<void> {
    if (this.initialized) return;
    console.log("🔄 Initializing Allowed Channels Cache...");
    try {
      const channels = await db
        .select({ telegramChannelId: allowedChannels.telegramChannelId })
        .from(allowedChannels);
      this.allowedChannelIdsSet = new Set(
        channels.map((c) => c.telegramChannelId),
      );
      this.initialized = true;
      console.log(
        `✅ Allowed Channels Cache initialized with ${this.allowedChannelIdsSet.size} channels.`,
      );
    } catch (error) {
      console.error("Error loading allowed channels into cache:", error);
      this.initialized = false;
    }
  }

  async createChannel(telegramChannelId: string, name?: string) {
    const existing = await db
      .select()
      .from(allowedChannels)
      .where(eq(allowedChannels.telegramChannelId, telegramChannelId))
      .limit(1);

    if (existing.length > 0) {
      throw new Error(
        `Channel with telegramChannelId ${telegramChannelId} already exists.`,
      );
    }

    const [newChannel] = await db
      .insert(allowedChannels)
      .values({ telegramChannelId, name, updatedAt: new Date() })
      .returning();

    this.allowedChannelIdsSet.add(newChannel.telegramChannelId);
    console.log(
      `Added channel ${newChannel.telegramChannelId} to cache. Cache size: ${this.allowedChannelIdsSet.size}`,
    );
    return newChannel;
  }

  async getAllChannels() {
    return db
      .select()
      .from(allowedChannels)
      .orderBy(desc(allowedChannels.createdAt));
  }

  async getChannelById(id: number) {
    const [channel] = await db
      .select()
      .from(allowedChannels)
      .where(eq(allowedChannels.id, id))
      .limit(1);
    return channel;
  }
  async getChannelByTelegramId(telegramChannelId: string) {
    const [channel] = await db
      .select()
      .from(allowedChannels)
      .where(eq(allowedChannels.telegramChannelId, telegramChannelId))
      .limit(1);
    return channel || null;
  }
  async deleteChannel(id: number) {
    const channelToDelete = await this.getChannelById(id);
    if (!channelToDelete) {
      throw new Error(`Channel with id ${id} not found.`);
    }

    await db.delete(allowedChannels).where(eq(allowedChannels.id, id));
    this.allowedChannelIdsSet.delete(channelToDelete.telegramChannelId);
    console.log(
      `Removed channel ${channelToDelete.telegramChannelId} from cache. Cache size: ${this.allowedChannelIdsSet.size}`,
    );
    return { success: true, message: "Channel deleted successfully" };
  }

  isChannelAllowed(telegramChannelId: string): boolean {
    if (!this.initialized) {
      console.warn(
        "AllowedChannelsCache not initialized, denying channel access by default. Attempting re-initialization...",
      );
      this.initializeCache().catch(console.error);
      return false;
    }
    return this.allowedChannelIdsSet.has(telegramChannelId);
  }

  getAllowedChannelIdsSet(): Set<string> {
    return this.allowedChannelIdsSet;
  }
}

export const allowedChannelsService = new AllowedChannelsService();
