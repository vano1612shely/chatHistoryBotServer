import Elysia from "elysia";
import { auth, protectedAuth } from "./auth/auth.controller";
import botController from "./telegram/telegram-controller";
import cors from "@elysiajs/cors";
import { mediaController } from "./telegram/media-controller";
import allowedChannelsController from "./telegram/allowed-channels-controller";
import { authGuard } from "./auth/auth.guard";
import { telegramBotController } from "./bot/bot-controller";
import { clientController } from "./client/client-controller";
import { subscriptionController } from "./subcription/subscription-controller";

const app = new Elysia({
  websocket: {
    idleTimeout: 960,
  },
})
  .use(
    cors({
      origin: "*",
    }),
  )
  .use(auth)
  .use(protectedAuth)
  .use(authGuard)
  .use(botController)
  .use(mediaController)
  .use(allowedChannelsController)
  .use(telegramBotController)
  .use(clientController)
  .use(subscriptionController)
  .listen({ idleTimeout: 100, port: 3000 });

console.log(`🚀 Сервер запущено на http://localhost:3000`);
