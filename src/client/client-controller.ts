import { Elysia, t } from "elysia";
import { ClientService } from "./client-service";

const clientService = new ClientService();

export const clientController = new Elysia({ prefix: "/client" })
  .decorate("userService", clientService)
  .get("/", async () => {
    try {
      const users = await clientService.getAllUsers();
      return {
        success: true,
        data: users,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Помилка отримання користувачів",
      };
    }
  })
  .get(
    "/telegram/:telegramId",
    async ({ params, set }) => {
      try {
        const user = await clientService.findUserByTelegramId(
          params.telegramId,
        );
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          data: user,
        };
      } catch (error) {
        set.status = 500;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка пошуку користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
    },
  )
  .put(
    "/telegram/:telegramId",
    async ({ params, body, set }) => {
      try {
        const user = await clientService.updateUser(params.telegramId, body);
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          message: "Користувач успішно оновлений",
          data: user,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка оновлення користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
      body: t.Object({
        username: t.Optional(t.String()),
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
      }),
    },
  )

  // Видалення користувача
  .delete(
    "/telegram/:telegramId",
    async ({ params, set }) => {
      try {
        const user = await clientService.deleteUser(params.telegramId);
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          message: "Користувач успішно видалений",
          data: user,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка видалення користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
    },
  );
