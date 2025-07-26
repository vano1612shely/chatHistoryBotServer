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

export interface ManualSubscriptionData {
  telegramId: string;
  durationDays: number;
  note?: string;
}

export class SubscriptionService {
  // Створення нового плану підписки
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

  // Отримання всіх планів підписки
  async getAllSubscriptionPlans() {
    return await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.isActive, true))
      .orderBy(subscriptionPlans.price);
  }

  // Отримання плану підписки по ID
  async getSubscriptionPlanById(id: number) {
    const plan = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, id))
      .limit(1);

    return plan[0] || null;
  }

  // Оновлення плану підписки
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

  // Видалення плану підписки (м'яке видалення)
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

  // Створення транзакції для покупки підписки
  async createSubscriptionTransaction(
    userId: number,
    subscriptionPlanId: number,
    telegramPaymentChargeId?: string,
    providerPaymentChargeId?: string,
  ) {
    const plan = await this.getSubscriptionPlanById(subscriptionPlanId);
    if (!plan) {
      throw new Error("План підписки не знайдений");
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

  // Створення підписки користувача після успішної оплати
  async createUserSubscription(
    userId: number,
    subscriptionPlanId: number,
    transactionId: number,
  ) {
    const plan = await this.getSubscriptionPlanById(subscriptionPlanId);
    if (!plan) {
      throw new Error("План підписки не знайдений");
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + plan.durationDays);

    // Деактивуємо попередні підписки користувача
    await db
      .update(userSubscriptions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, userId));

    // Створюємо нову підписку
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

    // Оновлюємо транзакцію
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

  private async getOrCreateManualSubscriptionPlan() {
    const existingPlan = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "MANUAL_SUBSCRIPTION"))
      .limit(1);

    if (existingPlan[0]) {
      return existingPlan[0];
    }

    // Створюємо системний план якщо його немає
    const newPlan = await db
      .insert(subscriptionPlans)
      .values({
        name: "MANUAL_SUBSCRIPTION",
        description: "Ручна підписка видана адміністратором",
        price: 0,
        durationDays: 0, // Тривалість буде встановлена індивідуально
        isActive: false, // Не показувати в списку доступних планів
      })
      .returning();

    return newPlan[0];
  }

  // Оновлений метод для ручної видачі підписки
  async grantManualSubscription(data: ManualSubscriptionData) {
    // Знаходимо користувача по telegramId
    const user = await db
      .select()
      .from(clients)
      .where(eq(clients.telegramId, data.telegramId))
      .limit(1);

    if (!user[0]) {
      throw new Error("Користувач не знайдений");
    }

    const userId = user[0].id;
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + data.durationDays);

    // Отримуємо або створюємо системний план
    const manualPlan = await this.getOrCreateManualSubscriptionPlan();

    // Деактивуємо попередні підписки користувача
    await db
      .update(userSubscriptions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, userId));

    // Створюємо нову підписку з посиланням на системний план
    const subscription = await db
      .insert(userSubscriptions)
      .values({
        userId,
        subscriptionPlanId: manualPlan.id, // Використовуємо ID системного плану
        startDate,
        endDate,
        isActive: true,
        isManual: true, // Якщо додали це поле
        manualNote: data.note, // Якщо додали це поле
      })
      .returning();

    // Створюємо запис транзакції для аудиту
    await db.insert(subscriptionTransactions).values({
      userId,
      subscriptionPlanId: manualPlan.id,
      userSubscriptionId: subscription[0].id,
      amount: 0, // Безкоштовно
      currency: "XTR",
      status: "completed",
      telegramPaymentChargeId: `manual_${Date.now()}`,
      providerPaymentChargeId: data.note || "Manual subscription by admin",
    });

    return {
      subscription: subscription[0],
      user: user[0],
      message: `Підписку на ${data.durationDays} днів успішно видано користувачу ${user[0].firstName || user[0].username}`,
    };
  }

  // Оновлений метод для отримання активної підписки
  async getUserActiveSubscription(userId: number) {
    const subscription = await db
      .select({
        id: userSubscriptions.id,
        subscriptionPlanId: userSubscriptions.subscriptionPlanId,
        startDate: userSubscriptions.startDate,
        endDate: userSubscriptions.endDate,
        isActive: userSubscriptions.isActive,
        isManual: userSubscriptions.isManual, // Якщо додали це поле
        manualNote: userSubscriptions.manualNote, // Якщо додали це поле
        planName: subscriptionPlans.name,
        planPrice: subscriptionPlans.price,
        planDurationDays: subscriptionPlans.durationDays,
      })
      .from(userSubscriptions)
      .leftJoin(
        // Змінено на leftJoin для підтримки null subscriptionPlanId
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

  // Отримання всіх транзакцій користувача
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
      .leftJoin(
        subscriptionPlans,
        eq(subscriptionTransactions.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(eq(subscriptionTransactions.userId, userId))
      .orderBy(desc(subscriptionTransactions.createdAt));
  }

  // Отримання всіх транзакцій (для адмінки)
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
      .leftJoin(
        subscriptionPlans,
        eq(subscriptionTransactions.subscriptionPlanId, subscriptionPlans.id),
      )
      .orderBy(desc(subscriptionTransactions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // Оновлення статусу транзакції
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
          lte(userSubscriptions.endDate, new Date()),
        ),
      )
      .returning();

    return expiredSubscriptions;
  }
}
