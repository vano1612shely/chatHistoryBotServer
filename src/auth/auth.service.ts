import { eq } from "drizzle-orm";
import { db } from "../database";
import { user } from "../database/schema";

export interface CreateUserData {
  login: string;
  password: string;
}

export interface LoginData {
  login: string;
  password: string;
}

export interface UserResponse {
  id: number;
  login: string;
}

export class AuthService {
  async createUser(userData: CreateUserData): Promise<UserResponse> {
    const { login, password } = userData;

    const existingUser = await db
      .select()
      .from(user)
      .where(eq(user.login, login))
      .limit(1);

    if (existingUser.length > 0) {
      throw new Error("USER_ALREADY_EXISTS");
    }

    // Хешуємо пароль
    const hashedPassword = await Bun.password.hash(password);

    // Створюємо користувача
    const newUser = await db
      .insert(user)
      .values({
        login,
        password: hashedPassword,
      })
      .returning({ id: user.id, login: user.login });

    return newUser[0];
  }

  async loginUser(loginData: LoginData): Promise<UserResponse> {
    const { login, password } = loginData;

    // Знаходимо користувача в базі даних
    const foundUser = await db
      .select()
      .from(user)
      .where(eq(user.login, login))
      .limit(1);

    if (foundUser.length === 0) {
      throw new Error("INVALID_CREDENTIALS");
    }

    // Перевіряємо пароль
    const isPasswordValid = await Bun.password.verify(
      password,
      foundUser[0].password,
    );

    if (!isPasswordValid) {
      throw new Error("INVALID_CREDENTIALS");
    }

    return {
      id: foundUser[0].id,
      login: foundUser[0].login,
    };
  }

  async verifyUser(userId: number): Promise<UserResponse | null> {
    const foundUser = await db
      .select({ id: user.id, login: user.login })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    return foundUser.length > 0 ? foundUser[0] : null;
  }
}
