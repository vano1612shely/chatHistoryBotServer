import { db } from "../database";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  clients,
  subscriptionPlans,
  userSubscriptions,
} from "../database/schema";

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
  async hasActiveSubscription(telegramId: string): Promise<boolean> {
    const result = await db
      .select({
        id: userSubscriptions.id,
      })
      .from(clients)
      .innerJoin(userSubscriptions, eq(clients.id, userSubscriptions.userId))
      .where(
        and(
          eq(clients.telegramId, telegramId),
          eq(userSubscriptions.isActive, true),
          gte(userSubscriptions.endDate, new Date()),
        ),
      )
      .limit(1);

    return result.length > 0;
  }
  async getUsersWithActiveSubscription() {
    return await db
      .select({
        userId: clients.id,
        telegramId: clients.telegramId,
        username: clients.username,
        firstName: clients.firstName,
        lastName: clients.lastName,
        name: clients.name,
        botId: clients.botId,
        createdAt: clients.createdAt,
        updatedAt: clients.updatedAt,
        subscriptionId: userSubscriptions.id,
        subscriptionStartDate: userSubscriptions.startDate,
        subscriptionEndDate: userSubscriptions.endDate,
        planId: subscriptionPlans.id,
        planName: subscriptionPlans.name,
        planPrice: subscriptionPlans.price,
        planDurationDays: subscriptionPlans.durationDays,
      })
      .from(clients)
      .innerJoin(userSubscriptions, eq(clients.id, userSubscriptions.userId))
      .innerJoin(
        subscriptionPlans,
        eq(userSubscriptions.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(userSubscriptions.isActive, true),
          gte(userSubscriptions.endDate, new Date()),
        ),
      );
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
    const now = new Date();

    const users = await db
      .select({
        id: clients.id,
        telegramId: clients.telegramId,
        username: clients.username,
        firstName: clients.firstName,
        lastName: clients.lastName,
        name: clients.name,
        botId: clients.botId,
        createdAt: clients.createdAt,
        updatedAt: clients.updatedAt,
        has_subscription: sql`CASE 
        WHEN ${userSubscriptions.id} IS NOT NULL 
          AND ${userSubscriptions.isActive} = true 
          AND ${userSubscriptions.endDate} >= ${now} 
        THEN true 
        ELSE false 
      END`.as("has_subscription"),
        subscription_end_date: userSubscriptions.endDate,
      })
      .from(clients)
      .leftJoin(
        userSubscriptions,
        and(
          eq(clients.id, userSubscriptions.userId),
          eq(userSubscriptions.isActive, true),
          gte(userSubscriptions.endDate, now),
        ),
      )
      .orderBy(desc(clients.createdAt));

    return users;
  }

  async deleteUser(telegramId: string) {
    const deletedUser = await db
      .delete(clients)
      .where(eq(clients.telegramId, telegramId))
      .returning();

    return deletedUser[0];
  }
}
