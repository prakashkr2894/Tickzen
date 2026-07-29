"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import type { User } from "./types";
import { apiRequest, clearToken, getToken, setToken, ApiError } from "./api";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  requestLoginOtp: (email: string) => Promise<void>;
  verifyLoginOtp: (email: string, otp: string) => Promise<void>;
  authenticateWithGoogle: (credential: string) => Promise<void>;
  signup: (data: SignupData) => Promise<void>;
  requestSignupOtp: (email: string) => Promise<void>;
  verifySignupEmailOtp: (email: string, otp: string) => Promise<{ verificationToken: string; trialAlreadyUsed: boolean }>;
  verifySignupOtp: (data: SignupData & { otp: string }) => Promise<void>;
  completeVerifiedSignup: (data: SignupData & { verificationToken: string }) => Promise<void>;
  signupAdmin: (data: AdminSignupData) => Promise<void>;
  logout: () => void;
  updateProfile: (data: UpdateProfileData) => Promise<void>;
}

interface SignupData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: string;
}

interface AdminSignupData extends SignupData {
  paymentAmount: number;
  paymentReference: string;
}

interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
  email?: string;
  avatarFile?: File | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const USER_KEY = "user";
const SESSION_KEY = "auth-session";

interface ApiUser {
  _id?: string;
  id: string;
  name: string;
  email: string;
  role: "admin" | "developer";
  createdAt?: string;
  avatar?: string;
  isTrialAdmin?: boolean;
  isPaidAdmin?: boolean;
  trialExpiresAt?: string | null;
}

const splitName = (name: string) => {
  const parts = (name || "").trim().split(/\s+/);
  const firstName = parts[0] || "User";
  const lastName = parts.slice(1).join(" ") || "";
  return { firstName, lastName };
};

const mapApiUser = (user: ApiUser): User => {
  const { firstName, lastName } = splitName(user.name);
  return {
    id: user.id || user._id || "",
    email: user.email,
    firstName,
    lastName,
    role: user.role,
    avatar: user.avatar,
    createdAt: user.createdAt || new Date().toISOString(),
    isTrialAdmin: user.isTrialAdmin,
    isPaidAdmin: user.isPaidAdmin,
    trialExpiresAt: user.trialExpiresAt,
  };
};

const getStoredUser = (): User | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
};

const setStoredUser = (user: User): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};

const getStoredSession = (): { token?: string; user?: User } | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { token?: string; user?: User }) : null;
  } catch {
    return null;
  }
};

const setStoredSession = (token: string, user: User): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
};

const clearStoredUser = (): void => {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_KEY);
};

const clearStoredSession = (): void => {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SESSION_KEY);
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const bootstrap = async () => {
      const storedSession = getStoredSession();
      if (storedSession?.token && !getToken()) {
        setToken(storedSession.token);
      }

      const token = getToken();
      if (!token) {
        clearStoredUser();
        clearStoredSession();
        setIsLoading(false);
        return;
      }

      const cachedUser = getStoredUser() || storedSession?.user || null;
      if (cachedUser) {
        setUser(cachedUser);
      }

      try {
        const response = await apiRequest<{ user: ApiUser }>("/auth/profile");
        const nextUser = mapApiUser(response.user);
        setUser(nextUser);
        setStoredUser(nextUser);
        setStoredSession(token, nextUser);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearToken();
          clearStoredUser();
          clearStoredSession();
          setUser(null);
        }
      } finally {
        setIsLoading(false);
      }
    };

    bootstrap();
  }, []);

  const requestLoginOtp = async (email: string) => {
    await apiRequest<{ message: string }>("/auth/login/send-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
      auth: false,
    });
  };

  const verifyLoginOtp = async (email: string, otp: string) => {
    const response = await apiRequest<{ token: string; user: ApiUser }>(
      "/auth/login/verify-otp",
      {
        method: "POST",
        body: JSON.stringify({ email, otp }),
        auth: false,
      }
    );
    setToken(response.token);
    const nextUser = mapApiUser(response.user);
    setUser(nextUser);
    setStoredUser(nextUser);
    setStoredSession(response.token, nextUser);
  };

  const authenticateWithGoogle = async (credential: string) => {
    const response = await apiRequest<{
      token?: string;
      user?: ApiUser;
      requiresAccountSelection?: boolean;
      email?: string;
      name?: string;
      verificationToken?: string;
      trialAlreadyUsed?: boolean;
    }>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
      auth: false,
    });

    if (response.requiresAccountSelection && response.verificationToken) {
      if (typeof window !== "undefined") {
        window.location.href = `/signup?email=${encodeURIComponent(response.email || "")}&name=${encodeURIComponent(response.name || "")}&verificationToken=${encodeURIComponent(response.verificationToken)}&trialAlreadyUsed=${response.trialAlreadyUsed || false}`;
      }
      return;
    }

    if (response.token && response.user) {
      setToken(response.token);
      const nextUser = mapApiUser(response.user);
      setUser(nextUser);
      setStoredUser(nextUser);
      setStoredSession(response.token, nextUser);
    }
  };

  const signup = async (data: SignupData) => {
    const response = await apiRequest<{ token: string; user: ApiUser }>(
      "/auth/signup",
      {
        method: "POST",
        body: JSON.stringify({
          name: `${data.firstName} ${data.lastName}`.trim(),
          email: data.email,
          password: data.password,
          role: data.role || "developer",
        }),
        auth: false,
      }
    );
    setToken(response.token);
    const nextUser = mapApiUser(response.user);
    setUser(nextUser);
    setStoredUser(nextUser);
    setStoredSession(response.token, nextUser);
  };

  const requestSignupOtp = async (email: string) => {
    await apiRequest<{ message: string }>("/auth/signup/send-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
      auth: false,
    });
  };

  const verifySignupEmailOtp = async (email: string, otp: string) => {
    const response = await apiRequest<{ message: string; verificationToken: string; trialAlreadyUsed: boolean }>(
      "/auth/signup/verify-email-otp",
      {
        method: "POST",
        body: JSON.stringify({ email, otp }),
        auth: false,
      }
    );

    return { verificationToken: response.verificationToken, trialAlreadyUsed: response.trialAlreadyUsed };
  };

  const verifySignupOtp = async (data: SignupData & { otp: string }) => {
    const response = await apiRequest<{ token: string; user: ApiUser }>(
      "/auth/signup/verify-otp",
      {
        method: "POST",
        body: JSON.stringify({
          name: `${data.firstName} ${data.lastName}`.trim(),
          email: data.email,
          password: data.password,
          otp: data.otp,
          role: data.role,
        }),
        auth: false,
      }
    );
    setToken(response.token);
    const nextUser = mapApiUser(response.user);
    setUser(nextUser);
    setStoredUser(nextUser);
    setStoredSession(response.token, nextUser);
  };

  const completeVerifiedSignup = async (data: SignupData & { verificationToken: string }) => {
    const response = await apiRequest<{ token: string; user: ApiUser }>(
      "/auth/signup/complete-verified",
      {
        method: "POST",
        body: JSON.stringify({
          name: `${data.firstName} ${data.lastName}`.trim(),
          email: data.email,
          password: data.password,
          verificationToken: data.verificationToken,
          role: data.role,
        }),
        auth: false,
      }
    );
    setToken(response.token);
    const nextUser = mapApiUser(response.user);
    setUser(nextUser);
    setStoredUser(nextUser);
    setStoredSession(response.token, nextUser);
  };

  const signupAdmin = async (data: AdminSignupData) => {
    const response = await apiRequest<{ token: string; user: ApiUser }>(
      "/auth/signup/admin",
      {
        method: "POST",
        body: JSON.stringify({
          name: `${data.firstName} ${data.lastName}`.trim(),
          email: data.email,
          password: data.password,
          paymentAmount: data.paymentAmount,
          paymentReference: data.paymentReference,
          paymentStatus: "paid",
        }),
        auth: false,
      }
    );
    setToken(response.token);
    const nextUser = mapApiUser(response.user);
    setUser(nextUser);
    setStoredUser(nextUser);
    setStoredSession(response.token, nextUser);
  };

  const logout = () => {
    clearToken();
    clearStoredUser();
    clearStoredSession();
    setUser(null);
  };

  const updateProfile = async (data: UpdateProfileData) => {
    if (user) {
      const name = `${data.firstName || user.firstName} ${data.lastName || user.lastName}`.trim();
      const hasAvatarFile = "avatarFile" in data && data.avatarFile instanceof File;
      const body = hasAvatarFile && data.avatarFile
        ? (() => {
            const formData = new FormData();
            formData.append("name", name);
            formData.append("email", data.email || user.email);
            formData.append("avatar", data.avatarFile);
            return formData;
          })()
        : JSON.stringify({
            name,
            email: data.email || user.email,
          });

      const response = await apiRequest<{ user: ApiUser }>("/auth/profile", {
        method: "PUT",
        body,
      });
      setUser(mapApiUser(response.user));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        requestLoginOtp,
        verifyLoginOtp,
        authenticateWithGoogle,
        signup,
        requestSignupOtp,
        verifySignupEmailOtp,
        verifySignupOtp,
        completeVerifiedSignup,
        signupAdmin,
        logout,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
