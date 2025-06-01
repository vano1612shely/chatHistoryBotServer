import { db } from "../database";
import { eq } from "drizzle-orm";
import { clients, user } from "../database/schema";

export interface UserData {
  telegramId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  botId: string;
}

export class ClientService {
  async findUserByTelegramId(telegramId: string) {
    const user = await db
      .select()
      .from(clients)
      .where(eq(clients.telegramId, telegramId))
      .limit(1);

    return user[0] || null;
  }

  async createUser(userData: UserData) {
    const newUser = await db
      .insert(clients)
      .values({
        botId: userData.botId,
        telegramId: userData.telegramId,
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName,
        name:
          userData.firstName && userData.lastName
            ? `${userData.firstName} ${userData.lastName}`
            : userData.firstName || userData.username,
      })
      .returning();

    return newUser[0];
  }

  async updateUser(telegramId: string, userData: Partial<UserData>) {
    const updatedUser = await db
      .update(clients)
      .set({
        ...userData,
        updatedAt: new Date(),
      })
      .where(eq(clients.telegramId, telegramId))
      .returning();

    return updatedUser[0];
  }

  async findOrCreateUser(userData: UserData) {
    let user = await this.findUserByTelegramId(userData.telegramId);

    if (!user) {
      user = await this.createUser(userData);
    }

    return user;
  }

  async getAllUsers() {
    return db.select().from(clients);
  }

  async deleteUser(telegramId: string) {
    const deletedUser = await db
      .delete(clients)
      .where(eq(clients.telegramId, telegramId))
      .returning();

    return deletedUser[0];
  }
}
