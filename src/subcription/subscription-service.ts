import { db } from "../database";
import {
  clients,
  subscriptionPlans,
  subscriptionTransactions,
  userSubscriptions,
} from "../database/schema";
import { and, desc, eq, gte, lte } from "drizzle-orm";

export interface CreateSubscriptionPlanData {
  name: string;
  description?: string;
  price: number;
  durationDays: number;
}

export interface UpdateSubscriptionPlanData {
  name?: string;
  description?: string;
  price?: number;
  durationDays?: number;
  isActive?: boolean;
}

export class SubscriptionService {
  // Создание нового плана подписки
  async createSubscriptionPlan(data: CreateSubscriptionPlanData) {
    const newPlan = await db
      .insert(subscriptionPlans)
      .values({
        name: data.name,
        description: data.description,
        price: data.price,
        durationDays: data.durationDays,
      })
      .returning();

    return newPlan[0];
  }

  // Получение всех планов подписки
  async getAllSubscriptionPlans() {
    return await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.isActive, true))
      .orderBy(subscriptionPlans.price);
  }

  // Получение плана подписки по ID
  async getSubscriptionPlanById(id: number) {
    const plan = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, id))
      .limit(1);

    return plan[0] || null;
  }

  // Обновление плана подписки
  async updateSubscriptionPlan(id: number, data: UpdateSubscriptionPlanData) {
    const updatedPlan = await db
      .update(subscriptionPlans)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionPlans.id, id))
      .returning();

    return updatedPlan[0];
  }

  // Удаление плана подписки (мягкое удаление)
  async deleteSubscriptionPlan(id: number) {
    const deletedPlan = await db
      .update(subscriptionPlans)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionPlans.id, id))
      .returning();

    return deletedPlan[0];
  }

  // Проверка активной подписки пользователя
  async getUserActiveSubscription(userId: number) {
    const subscription = await db
      .select({
        id: userSubscriptions.id,
        subscriptionPlanId: userSubscriptions.subscriptionPlanId,
        startDate: userSubscriptions.startDate,
        endDate: userSubscriptions.endDate,
        isActive: userSubscriptions.isActive,
        planName: subscriptionPlans.name,
        planPrice: subscriptionPlans.price,
        planDurationDays: subscriptionPlans.durationDays,
      })
      .from(userSubscriptions)
      .innerJoin(
        subscriptionPlans,
        eq(userSubscriptions.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.isActive, true),
          gte(userSubscriptions.endDate, new Date()),
        ),
      )
      .orderBy(desc(userSubscriptions.endDate))
      .limit(1);

    return subscription[0] || null;
  }

  // Создание транзакции для покупки подписки
  async createSubscriptionTransaction(
    userId: number,
    subscriptionPlanId: number,
    telegramPaymentChargeId?: string,
    providerPaymentChargeId?: string,
  ) {
    const plan = await this.getSubscriptionPlanById(subscriptionPlanId);
    if (!plan) {
      throw new Error("План подписки не найден");
    }

    const transaction = await db
      .insert(subscriptionTransactions)
      .values({
        userId,
        subscriptionPlanId,
        telegramPaymentChargeId,
        providerPaymentChargeId,
        amount: plan.price,
        status: "pending",
      })
      .returning();

    return transaction[0];
  }

  // Создание подписки пользователя после успешной оплаты
  async createUserSubscription(
    userId: number,
    subscriptionPlanId: number,
    transactionId: number,
  ) {
    const plan = await this.getSubscriptionPlanById(subscriptionPlanId);
    if (!plan) {
      throw new Error("План подписки не найден");
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + plan.durationDays);

    // Деактивируем предыдущие подписки пользователя
    await db
      .update(userSubscriptions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, userId));

    // Создаем новую подписку
    const subscription = await db
      .insert(userSubscriptions)
      .values({
        userId,
        subscriptionPlanId,
        startDate,
        endDate,
        isActive: true,
      })
      .returning();

    // Обновляем транзакцию
    await db
      .update(subscriptionTransactions)
      .set({
        userSubscriptionId: subscription[0].id,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(subscriptionTransactions.id, transactionId));

    return subscription[0];
  }

  // Получение всех транзакций пользователя
  async getUserTransactions(userId: number) {
    return await db
      .select({
        id: subscriptionTransactions.id,
        amount: subscriptionTransactions.amount,
        currency: subscriptionTransactions.currency,
        status: subscriptionTransactions.status,
        createdAt: subscriptionTransactions.createdAt,
        planName: subscriptionPlans.name,
        planDurationDays: subscriptionPlans.durationDays,
      })
      .from(subscriptionTransactions)
      .innerJoin(
        subscriptionPlans,
        eq(subscriptionTransactions.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(eq(subscriptionTransactions.userId, userId))
      .orderBy(desc(subscriptionTransactions.createdAt));
  }

  // Получение всех транзакций (для админки)
  async getAllTransactions(limit: number = 100, offset: number = 0) {
    return await db
      .select({
        id: subscriptionTransactions.id,
        userId: subscriptionTransactions.userId,
        userTelegramId: clients.telegramId,
        userName: clients.firstName,
        amount: subscriptionTransactions.amount,
        currency: subscriptionTransactions.currency,
        status: subscriptionTransactions.status,
        createdAt: subscriptionTransactions.createdAt,
        planName: subscriptionPlans.name,
        telegramPaymentChargeId:
          subscriptionTransactions.telegramPaymentChargeId,
      })
      .from(subscriptionTransactions)
      .innerJoin(clients, eq(subscriptionTransactions.userId, clients.id))
      .innerJoin(
        subscriptionPlans,
        eq(subscriptionTransactions.subscriptionPlanId, subscriptionPlans.id),
      )
      .orderBy(desc(subscriptionTransactions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // Обновление статуса транзакции
  async updateTransactionStatus(transactionId: number, status: string) {
    const updatedTransaction = await db
      .update(subscriptionTransactions)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionTransactions.id, transactionId))
      .returning();

    return updatedTransaction[0];
  }

  async deactivateExpiredSubscriptions() {
    const expiredSubscriptions = await db
      .update(userSubscriptions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userSubscriptions.isActive, true),
          lte(userSubscriptions.endDate, new Date()), // Змінено gte на lte - підписки що закінчились
        ),
      )
      .returning();

    return expiredSubscriptions;
  }
}
